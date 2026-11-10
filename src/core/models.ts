// Synap model catalog, read live from GET <origin>/v1/models.
//
// SHARED FILE: byte-identical copies live in synap-mcp/src/core/ and
// openclaw-provider-synap/src/core/ (a test in each package fails on drift).
// Nothing here is a hand-typed model or price list: ids, prices, context
// windows and capabilities all come from the live catalog at runtime.

export const DEFAULT_ORIGIN = "https://synap402.com";

/** The router id: picks the cheapest served model that can do the job. */
export const ROUTER_MODEL_ID = "synap-v1";

export interface SynapModelPricing {
  /** USD per million prompt tokens, as published by /v1/models. */
  inputPerMillion: number;
  /** USD per million completion tokens, as published by /v1/models. */
  outputPerMillion: number;
}

export interface SynapModel {
  id: string;
  name: string;
  /** One-line description: capability, routing note, or context note. */
  description: string;
  /** True for routing ids (synap-v1, synap-v1-pro) that pick a model per request. */
  router: boolean;
  /** True when the catalog marks the model as reading images. */
  vision: boolean;
  /** True when the catalog declares tool-calling support; undefined when it says nothing. */
  tools?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: SynapModelPricing;
  tier?: string;
}

type Row = Record<string, unknown>;

const isRecord = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
};
const posInt = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 1 ? Math.floor(n) : undefined;
};

/** Linear trailing-slash strip (no regex backtracking on long "////" runs). */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/** Normalizes an origin override. Only http(s) is accepted. */
export function normalizeOrigin(raw: string | undefined): string {
  const value = stripTrailingSlashes((raw ?? "").trim()) || DEFAULT_ORIGIN;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Synap origin must be http(s), got ${url.protocol}`);
  }
  // Accept ".../v1" too: users paste OpenAI-style base URLs.
  const path = stripTrailingSlashes(url.pathname).replace(/\/v1$/, "");
  return `${url.origin}${path}`;
}

function firstModality(row: Row, key: "input_modalities" | "output_modalities", type = "text"): Row | undefined {
  const list = row[key];
  if (!Array.isArray(list)) return undefined;
  return list.find((m): m is Row => isRecord(m) && m.type === type);
}

function readContextWindow(row: Row): number | undefined {
  const input = firstModality(row, "input_modalities");
  const supported = isRecord(input?.supported_inputs) ? input.supported_inputs : undefined;
  const max = isRecord(supported?.max_context_length) ? supported.max_context_length : undefined;
  return posInt(max?.value) ?? posInt(row.context_length) ?? posInt(row.context_window);
}

function readOutput(row: Row): { maxOutputTokens: number | undefined; tools: boolean | undefined } {
  const out = firstModality(row, "output_modalities");
  if (!out) return { maxOutputTokens: undefined, tools: undefined };
  const maxLen = isRecord(out.max_length) ? posInt(out.max_length.value) : undefined;
  const params = isRecord(out.supported_parameters) ? out.supported_parameters : undefined;
  const maxTok = params && isRecord(params.max_tokens) ? posInt(params.max_tokens.max) : undefined;
  return {
    maxOutputTokens: maxLen ?? maxTok,
    tools: params ? "tools" in params : undefined,
  };
}

function readPricing(row: Row): SynapModelPricing | undefined {
  const p = isRecord(row.pricing) ? row.pricing : undefined;
  if (!p) return undefined;
  if (p.currency !== undefined && p.currency !== "USD") return undefined;
  const input = num(p.prompt_per_million);
  const output = num(p.completion_per_million);
  if (input === undefined || output === undefined) return undefined;
  return { inputPerMillion: input, outputPerMillion: output };
}

function isVision(row: Row): boolean {
  if (firstModality(row, "input_modalities", "image")) return true;
  const cap = str(row.capability) ?? "";
  if (/\bvision\b/i.test(cap)) return true;
  const arch = isRecord(row.architecture) ? row.architecture : undefined;
  const mods = arch?.input_modalities;
  return Array.isArray(mods) && mods.includes("image");
}

/** True when the catalog row says the model cannot be requested right now. */
function isWithdrawn(row: Row): boolean {
  if (row.available === false) return true;
  const status = str(row.status) ?? str(row.availability);
  return status !== undefined && /^(soon|planned|retired|deprecated|disabled|unavailable)$/i.test(status);
}

/** One raw /v1/models row -> SynapModel, or null for rows that cannot be requested. */
export function normalizeModelRow(raw: unknown): SynapModel | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id || id.endsWith("*")) return null;
  if (isWithdrawn(raw)) return null;
  const routing = str(raw.routing);
  const out = readOutput(raw);
  const description = str(raw.capability) ?? (routing ? `Router: ${routing}` : undefined) ?? str(raw.context_note) ?? "";
  const model: SynapModel = {
    id,
    name: str(raw.name) ?? id,
    description,
    router: routing !== undefined,
    vision: isVision(raw),
  };
  if (out.tools !== undefined) model.tools = out.tools;
  const ctx = readContextWindow(raw);
  if (ctx !== undefined) model.contextWindow = ctx;
  if (out.maxOutputTokens !== undefined) model.maxOutputTokens = out.maxOutputTokens;
  const pricing = readPricing(raw);
  if (pricing) model.pricing = pricing;
  const tier = str(raw.tier);
  if (tier) model.tier = tier;
  return model;
}

/** Parses a /v1/models body into requestable models, routers first, ids unique. */
export function parseModelList(body: unknown): SynapModel[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const seen = new Set<string>();
  const models: SynapModel[] = [];
  for (const row of data) {
    const m = normalizeModelRow(row);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push(m);
  }
  // Stable: routers first (in catalog order), then everything else in catalog order.
  return [...models.filter((m) => m.router), ...models.filter((m) => !m.router)];
}

export interface FetchModelsOptions {
  origin?: string;
  fetch?: typeof globalThis.fetch;
  /** Optional bearer; /v1/models is public, a key only scopes the answer to that account. */
  apiKey?: string;
  userAgent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** GET <origin>/v1/models -> requestable models. Throws on HTTP or parse failure. */
export async function fetchModels(opts: FetchModelsOptions = {}): Promise<SynapModel[]> {
  const origin = normalizeOrigin(opts.origin);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.userAgent) headers["user-agent"] = opts.userAgent;
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await doFetch(`${origin}/v1/models`, { headers, signal, redirect: "error" });
  if (!res.ok) throw new Error(`GET ${origin}/v1/models answered HTTP ${res.status}`);
  const models = parseModelList(await res.json());
  if (!models.length) throw new Error(`GET ${origin}/v1/models returned no requestable models`);
  return models;
}

/** A small TTL cache around fetchModels, one entry per origin. */
export class ModelCatalog {
  private cache = new Map<string, { at: number; models: SynapModel[] }>();
  private inflight = new Map<string, Promise<SynapModel[]>>();
  private readonly opts: FetchModelsOptions & { ttlMs?: number };
  constructor(opts: FetchModelsOptions & { ttlMs?: number } = {}) {
    this.opts = opts;
  }

  async list(force = false): Promise<SynapModel[]> {
    const origin = normalizeOrigin(this.opts.origin);
    const ttl = this.opts.ttlMs ?? 60_000;
    const hit = this.cache.get(origin);
    if (!force && hit && Date.now() - hit.at < ttl) return hit.models;
    const pending = this.inflight.get(origin);
    if (pending) return pending;
    const p = fetchModels(this.opts)
      .then((models) => {
        this.cache.set(origin, { at: Date.now(), models });
        return models;
      })
      .finally(() => this.inflight.delete(origin));
    this.inflight.set(origin, p);
    return p;
  }
}

/** The model for plain text work: the explicit choice, else the router when listed, else the first model. */
export function pickTextModel(models: SynapModel[], preferred?: string): string {
  if (preferred && preferred.trim()) return preferred.trim();
  if (models.some((m) => m.id === ROUTER_MODEL_ID)) return ROUTER_MODEL_ID;
  const first = models.find((m) => !m.router) ?? models[0];
  if (!first) throw new Error("No Synap model is available right now");
  return first.id;
}

/** The model for image input: the explicit choice, else the cheapest vision model listed. */
export function pickVisionModel(models: SynapModel[], preferred?: string): string {
  if (preferred && preferred.trim()) return preferred.trim();
  const vision = models.filter((m) => m.vision && !m.router);
  if (!vision.length) throw new Error("No vision model is listed at /v1/models right now; pass `model` explicitly");
  vision.sort((a, b) => (a.pricing?.outputPerMillion ?? Infinity) - (b.pricing?.outputPerMillion ?? Infinity));
  return vision[0]!.id;
}

/** Human-readable price, e.g. "$0.07 in / $0.27 out per 1M tokens". */
export function formatPricing(p: SynapModelPricing | undefined): string {
  if (!p) return "billed at the rate of the model that runs";
  const f = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toPrecision(2)}` : `$${Number(n.toFixed(4))}`);
  return `${f(p.inputPerMillion)} in / ${f(p.outputPerMillion)} out per 1M tokens`;
}
