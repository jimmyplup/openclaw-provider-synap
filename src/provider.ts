// The Synap provider for OpenClaw, as plain objects so it can be unit-tested
// without the host. index.ts hands these to OpenClaw's
// defineSingleProviderPluginEntry (openclaw/plugin-sdk/provider-entry).
//
// Two payment paths, chosen per catalog run:
//   API key  -> baseUrl https://synap402.com/v1, Bearer key (OpenClaw auth profile or env)
//   x402     -> baseUrl http://127.0.0.1:<port>/v1, a local proxy that pays each call in USDC
import { readFileSync } from "node:fs";
import { ModelCatalog, type SynapModel } from "./core/models.ts";
import { createPayFetch, hasWallet, walletDir } from "./core/x402.ts";
import { dynamicModelRow, toOpenClawModels, type OpenClawProviderConfig } from "./openclaw-models.ts";
import { loadProxyToken, startProxy, type ProxyHandle } from "./proxy.ts";
import { API_KEY_ENV_VARS, PROVIDER_ID, readSettings, type SynapPluginSettings } from "./settings.ts";

export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();
export const USER_AGENT = `openclaw-provider-synap/${VERSION}`;
export const DEFAULT_MODEL_REF = `${PROVIDER_ID}/synap-v1`;

/** The subset of OpenClaw's plugin API this provider uses. */
export interface PluginApiLike {
  pluginConfig?: Record<string, unknown>;
  /** "full" on normal gateway startup; discovery/metadata loads must not start services. */
  registrationMode?: string;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  registerService?: (service: {
    id: string;
    start: (ctx: unknown) => void | Promise<void>;
    stop?: (ctx: unknown) => void | Promise<void>;
  }) => void;
}

/** The subset of OpenClaw's ProviderCatalogContext this provider uses. */
export interface CatalogContextLike {
  providerIds?: readonly string[];
  env?: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId?: string) => { apiKey: string | undefined };
}

export interface DynamicModelContextLike {
  modelId: string;
  providerConfig?: { baseUrl?: string };
}

const catalogs = new Map<string, ModelCatalog>();
function catalogFor(origin: string, apiKey?: string): ModelCatalog {
  const key = `${origin}|${apiKey ? "key" : "public"}`;
  let c = catalogs.get(key);
  if (!c) {
    const opts: ConstructorParameters<typeof ModelCatalog>[0] = { origin, userAgent: USER_AGENT, ttlMs: 60_000 };
    if (apiKey) opts.apiKey = apiKey;
    c = new ModelCatalog(opts);
    catalogs.set(key, c);
  }
  return c;
}

/** Last successful catalog per origin, for synchronous model resolution. */
const snapshots = new Map<string, SynapModel[]>();

/** Live models; on failure the router id alone, so a transient outage never removes the provider. */
async function liveModels(origin: string, apiKey: string | undefined, warn: (m: string) => void): Promise<SynapModel[]> {
  try {
    const models = await catalogFor(origin, apiKey).list();
    snapshots.set(origin, models);
    return models;
  } catch (e) {
    warn(`[synap] could not read ${origin}/v1/models (${(e as Error).message}); offering the router only until it answers`);
    return [{ id: "synap-v1", name: "synap-v1", description: "", router: true, vision: false }];
  }
}

export const proxyBaseUrl = (s: SynapPluginSettings) => `http://127.0.0.1:${s.port}/v1`;

/** True when a wallet path is configured and allowed by the mode. */
export function walletPathEnabled(s: SynapPluginSettings): boolean {
  return s.mode === "x402" || (s.mode === "auto" && hasWallet(s.wallet));
}

export async function runSynapCatalog(
  ctx: CatalogContextLike,
  settings: SynapPluginSettings,
  warn: (m: string) => void = () => {},
): Promise<{ provider: OpenClawProviderConfig } | null> {
  if (ctx.providerIds !== undefined && !ctx.providerIds.includes(PROVIDER_ID)) return null;
  const apiKey = settings.mode !== "x402" ? ctx.resolveProviderApiKey(PROVIDER_ID).apiKey : undefined;
  debug(`catalog.run: mode=${settings.mode} key=${apiKey ? "yes" : "no"} walletPath=${walletPathEnabled(settings)}`);
  if (apiKey) {
    const models = await liveModels(settings.origin, apiKey, warn);
    return { provider: { baseUrl: `${settings.origin}/v1`, api: "openai-completions", apiKey, timeoutSeconds: 300, models: toOpenClawModels(models) } };
  }
  if (!walletPathEnabled(settings)) return null;
  const models = await liveModels(settings.origin, undefined, warn);
  return {
    provider: {
      baseUrl: proxyBaseUrl(settings),
      api: "openai-completions",
      apiKey: loadProxyToken(walletDir(ctx.env ?? process.env)),
      timeoutSeconds: 300,
      models: toOpenClawModels(models),
    },
  };
}

/** The `provider` object for defineSingleProviderPluginEntry. */
export function createSynapProvider(api: PluginApiLike) {
  const settings = () => readSettings(api.pluginConfig);
  const warn = (m: string) => api.logger?.warn?.(m);
  return {
    id: PROVIDER_ID,
    label: "Synap by Linkrra",
    docsPath: "https://synap402.com",
    envVars: [...API_KEY_ENV_VARS],
    auth: [
      {
        methodId: "api-key",
        label: "Synap API key",
        hint: "Create a key at https://synap402.com (or pay per call in USDC with a wallet, no key)",
        optionKey: "synapApiKey",
        flagName: "--synap-api-key",
        envVar: "SYNAP_API_KEY",
        promptMessage: "Enter your Synap API key",
        defaultModel: DEFAULT_MODEL_REF,
      },
    ],
    catalog: {
      order: "simple" as const,
      run: (ctx: CatalogContextLike) => runSynapCatalog(ctx, settings(), warn),
    },
    /** Async path: read the live catalog so price and context window are exact for this id. */
    prepareDynamicModel: async (ctx: DynamicModelContextLike) => {
      const s = settings();
      await liveModels(s.origin, undefined, warn);
      const row = resolveSynapModel(ctx, s);
      debug(`prepareDynamicModel ${ctx.modelId} -> ${row.baseUrl} (ctx ${row.contextWindow})`);
      return row;
    },
    /** Sync path: the last catalog snapshot, else a conservative row for an id listed since. */
    resolveDynamicModel: (ctx: DynamicModelContextLike) => {
      const row = resolveSynapModel(ctx, settings());
      debug(`resolveDynamicModel ${ctx.modelId} -> ${row.baseUrl}`);
      return row;
    },
  };
}

/**
 * The openclaw.json patch for wallet mode. OpenClaw only sends a credential it
 * can resolve, so the local proxy's token is supplied as a file SecretRef
 * (the token file itself, 0600) on an explicit models.providers.synap entry
 * pointing at the loopback proxy. No secret is written into openclaw.json.
 */
export function walletConfigPatch(opts: { port: number; tokenPath: string; maxPerCallUsd?: number }) {
  return {
    secrets: { providers: { synap_proxy: { source: "file", path: opts.tokenPath, mode: "singleValue" } } },
    plugins: { entries: { [PROVIDER_ID]: { enabled: true, config: { mode: "x402", ...(opts.maxPerCallUsd ? { maxPerCallUsd: opts.maxPerCallUsd } : {}) } } } },
    models: {
      providers: {
        [PROVIDER_ID]: {
          baseUrl: `http://127.0.0.1:${opts.port}/v1`,
          api: "openai-completions",
          apiKey: { source: "file", provider: "synap_proxy", id: "value" },
          models: [],
        },
      },
    },
    agents: { defaults: { model: { primary: DEFAULT_MODEL_REF } } },
  };
}

/** SYNAP_DEBUG=1 traces provider decisions to stderr (never credentials). */
function debug(msg: string): void {
  if (/^(1|true|yes|on)$/i.test(process.env.SYNAP_DEBUG ?? "")) process.stderr.write(`[synap:debug] ${msg}\n`);
}

/** A runtime model row for any id Synap serves, with live data when the catalog has been read. */
export function resolveSynapModel(ctx: DynamicModelContextLike, s: SynapPluginSettings) {
  const baseUrl =
    ctx.providerConfig?.baseUrl ?? (walletPathEnabled(s) && !process.env.SYNAP_API_KEY && !process.env.LINKRRA_API_KEY ? proxyBaseUrl(s) : `${s.origin}/v1`);
  const id = ctx.modelId.replace(/^synap\//, "");
  const live = snapshots.get(s.origin)?.find((m) => m.id === id);
  const row = live ? toOpenClawModels([live])[0]! : dynamicModelRow(id);
  return { ...row, provider: PROVIDER_ID, api: "openai-completions" as const, baseUrl };
}

let proxy: ProxyHandle | null = null;
let starting: Promise<void> | null = null;

/**
 * Registers the local x402 proxy as a gateway service. Only in "full" loads
 * (normal gateway startup); register() may run several times per process, so
 * the proxy itself is a module-level singleton and start() is idempotent.
 */
export function registerSynapServices(api: PluginApiLike): void {
  if (!api.registerService) return;
  if (api.registrationMode !== undefined && api.registrationMode !== "full") return;
  const info = (m: string) => api.logger?.info?.(`[synap] ${m}`);
  const warn = (m: string) => api.logger?.warn?.(`[synap] ${m}`);
  api.registerService({
    id: "synap-x402-proxy",
    start: async () => {
      if (proxy || starting) return starting ?? undefined;
      const s = readSettings(api.pluginConfig);
      if (!walletPathEnabled(s)) return;
      starting = (async () => {
        try {
          const payOpts: Parameters<typeof createPayFetch>[0] = { keys: s.wallet, origin: s.origin, maxPerCallUsd: s.maxPerCallUsd };
          if (s.preferNetwork) payOpts.preferNetwork = s.preferNetwork;
          if (s.maxTotalUsd !== undefined) payOpts.maxTotalUsd = s.maxTotalUsd;
          const payFetch = await createPayFetch(payOpts);
          const opts: Parameters<typeof startProxy>[0] = {
            origin: s.origin,
            payFetch,
            token: loadProxyToken(walletDir()),
            listModels: () => catalogFor(s.origin).list(),
            port: s.port,
            userAgent: USER_AGENT,
            log: info,
          };
          if (s.maxTotalUsd !== undefined) opts.maxTotalUsd = s.maxTotalUsd;
          proxy = await startProxy(opts);
          if (payFetch) {
            const who = [payFetch.addresses.base && `Base ${payFetch.addresses.base}`, payFetch.addresses.solana && `Solana ${payFetch.addresses.solana}`].filter(Boolean).join(", ");
            info(`paying per call from ${who}; ceiling $${payFetch.maxPerCallUsd}/call${s.maxTotalUsd ? `, budget $${s.maxTotalUsd}` : ""}`);
          } else {
            warn("mode is x402 but no wallet is configured; calls will answer 402 with setup steps");
          }
        } catch (e) {
          warn(`x402 proxy did not start: ${(e as Error).message}`);
        } finally {
          starting = null;
        }
      })();
      return starting;
    },
    stop: async () => {
      const p = proxy;
      proxy = null;
      if (p) await p.close();
    },
  });
}

/** Test hook: forget module state between tests. */
export function __resetForTests(): void {
  catalogs.clear();
  snapshots.clear();
  proxy = null;
  starting = null;
}

/** The running proxy, if any (diagnostics and tests). */
export const activeProxy = (): ProxyHandle | null => proxy;
