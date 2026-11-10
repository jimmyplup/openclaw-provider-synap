// Local x402 proxy: OpenClaw (or any OpenAI client) calls
// http://127.0.0.1:<port>/v1, the proxy pays Synap per call in USDC from the
// configured wallet and relays the answer (streams byte for byte).
//
// Who can spend: the proxy listens on loopback only, refuses any request that
// carries a browser Origin header or a non-loopback Host (so a web page cannot
// reach it), and requires a bearer token stored 0600 in the wallet dir (so
// other local programs cannot spend the wallet without reading that file).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { SynapModel } from "./core/models.ts";
import { readSettlement, X402_CHAT_PATH, type PayFetch } from "./core/x402.ts";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const PASS_HEADERS = ["content-type", "cache-control", "payment-response", "x-payment-response", "x-request-id"];

/** Loads (or creates once) the proxy bearer token at <dir>/proxy.token, mode 0600. */
export function loadProxyToken(dir: string): string {
  const path = join(dir, "proxy.token");
  try {
    if (existsSync(path)) {
      const t = readFileSync(path, "utf8").trim();
      if (/^synap-local-[A-Za-z0-9_-]{32,}$/.test(t)) return t;
    }
  } catch {
    /* recreate below */
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = `synap-local-${randomBytes(24).toString("base64url")}`;
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return token;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** An x402 offer body (402 challenge or refusal) as a short OpenAI-style error; null for other bodies. */
export function x402BodyAsOpenAIError(status: number, doc: unknown): Json | null {
  if (!isRecord(doc) || typeof doc.x402Version !== "number") return null;
  const parts: string[] = [];
  if (typeof doc.error === "string" && !/PAYMENT-SIGNATURE header is required/i.test(doc.error)) parts.push(doc.error);
  const quote = isRecord(doc.quote) ? doc.quote : undefined;
  if (quote && typeof quote.model === "string" && /not offered/.test(quote.model)) parts.push(quote.model);
  const suggested = isRecord(doc.suggested_model) ? doc.suggested_model : undefined;
  if (suggested && typeof suggested.id === "string") parts.push(`Suggested model: ${suggested.id}.`);
  const message = parts.join(" ") || `Synap answered HTTP ${status} (payment required)`;
  return { error: { message, type: status === 402 ? "payment_required" : "upstream_error", code: null } };
}

function send(res: ServerResponse, status: number, body: Json, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

const oaiError = (message: string, type: string, code?: string): Json => ({ error: { message, type, code: code ?? null } });

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ProxyOptions {
  origin: string;
  payFetch: PayFetch | null;
  token: string;
  listModels: () => Promise<SynapModel[]>;
  port?: number;
  host?: string;
  userAgent: string;
  /** Per-process spend budget across all paid calls; undefined = none. */
  maxTotalUsd?: number;
  log?: (msg: string) => void;
}

export interface ProxyHandle {
  baseUrl: string;
  port: number;
  mode: "x402" | "unpaid";
  close(): Promise<void>;
  stats(): { requests: number; paidCalls: number; spentUsd: number; errors: number };
}

export async function startProxy(o: ProxyOptions): Promise<ProxyHandle> {
  const host = o.host ?? "127.0.0.1";
  const log = o.log ?? (() => {});
  const stats = { requests: 0, errors: 0 };
  const mode: ProxyHandle["mode"] = o.payFetch ? "x402" : "unpaid";
  const spent = () => o.payFetch?.totalUsd() ?? 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    stats.requests++;
    if (req.headers.origin !== undefined) {
      return send(res, 403, oaiError("Browser-origin requests are refused: this proxy spends a wallet and serves native clients only.", "forbidden"));
    }
    const hostName = String(req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (hostName && !["127.0.0.1", "localhost", "::1"].includes(hostName)) {
      return send(res, 403, oaiError(`Host "${hostName.slice(0, 64)}" is not loopback; refused.`, "forbidden"));
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, {
        ok: true,
        mode,
        origin: o.origin,
        networks: o.payFetch?.networks ?? [],
        addresses: o.payFetch?.addresses ?? {},
        maxPerCallUsd: o.payFetch?.maxPerCallUsd ?? null,
        paidCalls: o.payFetch?.payments.length ?? 0,
        spentUsd: Number(spent().toFixed(6)),
      });
    }
    if (!url.pathname.startsWith("/v1/")) return send(res, 404, oaiError(`No route for ${req.method} ${url.pathname}`, "invalid_request_error"));
    if (!tokenMatches(req.headers.authorization, o.token)) {
      return send(res, 401, oaiError("Missing or wrong proxy token (see proxy.token in the Synap wallet directory).", "authentication_error"));
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const models = await o.listModels();
      return send(res, 200, { object: "list", data: models.map((m) => ({ id: m.id, object: "model", owned_by: "synap" })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const raw = await readBody(req);
      let body: Json;
      try {
        const parsed = JSON.parse(raw.toString("utf8") || "{}") as unknown;
        if (!isRecord(parsed)) throw new Error("not an object");
        body = parsed;
      } catch {
        return send(res, 400, oaiError("Request body must be a JSON object", "invalid_request_error"));
      }
      if (typeof body.model === "string") body.model = body.model.replace(/^synap\//, "");
      if (!o.payFetch) {
        return send(
          res,
          402,
          oaiError(
            "No wallet configured for x402 payment. Set SYNAP_WALLET_KEY (Base) or SYNAP_SOLANA_KEY, run `npx openclaw-provider-synap wallet new`, or use an API key from https://synap402.com.",
            "payment_required",
            "synap_unconfigured",
          ),
        );
      }
      if (o.maxTotalUsd !== undefined && spent() >= o.maxTotalUsd) {
        return send(res, 402, oaiError(`Spend budget reached: $${spent().toFixed(4)} of $${o.maxTotalUsd} (maxTotalUsd). Raise it or restart to reset.`, "payment_required", "synap_budget_reached"));
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
        "user-agent": o.userAgent,
      };
      const before = o.payFetch.payments.length;
      const up = await o.payFetch.fetch(`${o.origin}${X402_CHAT_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const paid = o.payFetch.payments.slice(before).at(-1);
      if (paid) {
        const tx = readSettlement(up.headers)?.transaction;
        log(`paid ${paid.amountUsd !== undefined ? `$${paid.amountUsd}` : paid.amountAtomic} on ${paid.network} for ${String(body.model)}${tx ? ` (tx ${tx})` : ""}`);
      }
      if (up.status >= 300 && up.status < 400) {
        stats.errors++;
        return send(res, 502, oaiError(`Synap answered a redirect (HTTP ${up.status}); paid calls never follow redirects.`, "upstream_redirect_refused"));
      }
      const out: Record<string, string> = {};
      for (const h of PASS_HEADERS) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
      }
      if (!up.ok && /json/i.test(out["content-type"] ?? "")) {
        const text = await up.text();
        let doc: unknown = null;
        try {
          doc = JSON.parse(text);
        } catch {
          /* relay as sent */
        }
        const mapped = x402BodyAsOpenAIError(up.status, doc);
        if (mapped) {
          const { "content-type": _ct, ...rest } = out;
          return send(res, up.status, mapped, rest);
        }
        res.writeHead(up.status, out);
        res.end(text);
        return;
      }
      res.writeHead(up.status, out);
      if (!up.body) {
        res.end();
        return;
      }
      const reader = up.body.getReader();
      req.on("close", () => {
        reader.cancel().catch(() => {});
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    }
    return send(res, 404, oaiError(`No route for ${req.method} ${url.pathname}`, "invalid_request_error"));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      stats.errors++;
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      log(`${req.method} ${req.url}: ${msg}`);
      if (!res.headersSent) send(res, 502, oaiError(`Synap x402 proxy: ${msg}`, "upstream_error"));
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://${host}:${port}`;
  log(`x402 proxy on ${baseUrl}/v1 -> ${o.origin} (${mode})`);
  return {
    baseUrl,
    port,
    mode,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    stats: () => ({ requests: stats.requests, errors: stats.errors, paidCalls: o.payFetch?.payments.length ?? 0, spentUsd: spent() }),
  };
}
