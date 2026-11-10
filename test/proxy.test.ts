import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseModelList } from "../src/core/models.ts";
import type { PayFetch } from "../src/core/x402.ts";
import { loadProxyToken, startProxy, x402BodyAsOpenAIError } from "../src/proxy.ts";

const TOKEN = "synap-local-" + "a".repeat(32);
const models = parseModelList({ data: [{ id: "synap-v1", routing: "auto" }, { id: "qwen3-coder-30b" }] });

function fakePay(handler: (url: string, init: RequestInit) => Response | Promise<Response>, perCall = 0.001): PayFetch & { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const payments: PayFetch["payments"] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body) });
      payments.push({ network: "eip155:8453", asset: "usdc", payTo: "x", amountAtomic: "1000", amountUsd: perCall, at: "now" });
      return handler(String(input), init ?? {});
    }) as typeof fetch,
    networks: ["eip155:8453"],
    addresses: { base: "0xabc" },
    maxPerCallUsd: 0.1,
    payments,
    totalUsd: () => payments.reduce((s, p) => s + (p.amountUsd ?? 0), 0),
  };
}

async function proxyWith(payFetch: PayFetch | null, extra: { maxTotalUsd?: number } = {}) {
  return startProxy({ origin: "https://synap402.com", payFetch, token: TOKEN, listModels: async () => models, userAgent: "t", ...extra });
}

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** Raw request so tests can set Host and Origin headers fetch() would not let through. */
function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

test("loadProxyToken creates a 0600 token once and reuses it", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "synap-tok-")), "d");
  const a = loadProxyToken(dir);
  assert.match(a, /^synap-local-[A-Za-z0-9_-]{32,}$/);
  assert.equal(statSync(join(dir, "proxy.token")).mode & 0o777, 0o600);
  assert.equal(loadProxyToken(dir), a);
});

test("refuses browsers, non-loopback hosts and callers without the token", async () => {
  const p = await proxyWith(fakePay(() => new Response("{}")));
  try {
    const body = JSON.stringify({ model: "m", messages: [] });
    assert.equal((await raw(p.port, { method: "POST", path: "/v1/chat/completions", headers: { ...auth, origin: "https://evil.example" }, body })).status, 403);
    assert.equal((await raw(p.port, { method: "POST", path: "/v1/chat/completions", headers: { ...auth, host: "attacker.example" }, body })).status, 403);
    assert.equal((await raw(p.port, { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" }, body })).status, 401);
    assert.equal((await raw(p.port, { method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer wrong" }, body })).status, 401);
    assert.equal((await raw(p.port, { path: "/health" })).status, 200, "health needs no token");
  } finally {
    await p.close();
  }
});

test("lists models and reports health without secrets", async () => {
  const p = await proxyWith(fakePay(() => new Response("{}")));
  try {
    const m = await fetch(`${p.baseUrl}/v1/models`, { headers: auth });
    assert.deepEqual(((await m.json()) as { data: Array<{ id: string }> }).data.map((d) => d.id), ["synap-v1", "qwen3-coder-30b"]);
    const h = (await (await fetch(`${p.baseUrl}/health`)).json()) as Record<string, unknown>;
    assert.equal(h.mode, "x402");
    assert.equal(h.maxPerCallUsd, 0.1);
    assert.doesNotMatch(JSON.stringify(h), /synap-local-/);
  } finally {
    await p.close();
  }
});

test("forwards to the x402 door, strips the provider prefix, relays receipts", async () => {
  const pay = fakePay(() =>
    new Response(JSON.stringify({ model: "qwen3-coder-30b", choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json", "payment-response": "eyJ4IjoxfQ==" },
    }),
  );
  const p = await proxyWith(pay);
  try {
    const r = await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "synap/qwen3-coder-30b", messages: [{ role: "user", content: "hi" }], tools: [] }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("payment-response"), "eyJ4IjoxfQ==");
    assert.equal(pay.calls[0]!.url, "https://synap402.com/api/billing/x402/chat/completions");
    const sent = JSON.parse(pay.calls[0]!.body) as { model: string; tools: unknown[] };
    assert.equal(sent.model, "qwen3-coder-30b");
    assert.deepEqual(sent.tools, [], "other fields pass through untouched");
    assert.equal(p.stats().paidCalls, 1);
  } finally {
    await p.close();
  }
});

test("streams pass through chunk by chunk", async () => {
  const pay = fakePay(() => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"he"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n'));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const p = await proxyWith(pay);
  try {
    const r = await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "m", stream: true, messages: [] }) });
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const text = await r.text();
    assert.match(text, /"he"[\s\S]*"llo"[\s\S]*\[DONE\]/);
  } finally {
    await p.close();
  }
});

test("without a wallet: 402 with setup steps, nothing forwarded", async () => {
  const p = await proxyWith(null);
  try {
    const r = await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal(r.status, 402);
    const e = ((await r.json()) as { error: { message: string; code: string } }).error;
    assert.equal(e.code, "synap_unconfigured");
    assert.match(e.message, /SYNAP_WALLET_KEY[\s\S]*synap402\.com/);
  } finally {
    await p.close();
  }
});

test("spend budget stops paying once reached", async () => {
  const pay = fakePay(() => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }), 0.05);
  const p = await proxyWith(pay, { maxTotalUsd: 0.1 });
  try {
    const call = () => fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    const third = await call();
    assert.equal(third.status, 402);
    assert.match(((await third.json()) as { error: { message: string } }).error.message, /budget reached/);
    assert.equal(pay.calls.length, 2);
  } finally {
    await p.close();
  }
});

test("x402 refusal bodies become one readable sentence; other errors relay as sent", async () => {
  const mapped = x402BodyAsOpenAIError(402, {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    accepts: [{ scheme: "exact" }],
    quote: { model: '"x" is not offered. Suggested: gemma.' },
    suggested_model: { id: "gemma" },
  });
  assert.deepEqual(mapped, { error: { message: '"x" is not offered. Suggested: gemma. Suggested model: gemma.', type: "payment_required", code: null } });
  assert.equal(x402BodyAsOpenAIError(500, { error: "x" }), null);

  const pay = fakePay(() => new Response(JSON.stringify({ x402Version: 2, error: "insufficient funds", accepts: [{}] }), { status: 402, headers: { "content-type": "application/json" } }));
  const p = await proxyWith(pay);
  try {
    const r = await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal(r.status, 402);
    assert.deepEqual(await r.json(), { error: { message: "insufficient funds", type: "payment_required", code: null } });
  } finally {
    await p.close();
  }
  const pay2 = fakePay(() => { throw new Error("quote $0.5 exceeds the per-call ceiling $0.1"); });
  const p2 = await proxyWith(pay2);
  try {
    const r = await fetch(`${p2.baseUrl}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal(r.status, 502);
    assert.match(((await r.json()) as { error: { message: string } }).error.message, /ceiling/);
  } finally {
    await p2.close();
  }
});

test("rejects non-JSON bodies and unknown routes", async () => {
  const p = await proxyWith(fakePay(() => new Response("{}")));
  try {
    assert.equal((await fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: auth, body: "nope" })).status, 400);
    assert.equal((await fetch(`${p.baseUrl}/v1/embeddings`, { method: "POST", headers: auth, body: "{}" })).status, 404);
    assert.equal((await fetch(`${p.baseUrl}/admin`)).status, 404);
  } finally {
    await p.close();
  }
});
