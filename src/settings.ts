// Plugin settings: plugins.entries.synap.config in openclaw.json, then env.
import { DEFAULT_ORIGIN, normalizeOrigin } from "./core/models.ts";
import { parseMaxPerCallUsd, parsePreferredNetwork, resolveWalletKeys, type PayNetwork, type WalletKeys } from "./core/x402.ts";

export const PROVIDER_ID = "synap";
export const PLUGIN_ID = "synap";
export const DEFAULT_PORT = 8419;
export const API_KEY_ENV_VARS = ["SYNAP_API_KEY", "LINKRRA_API_KEY"] as const;

export type ModeSetting = "auto" | "api-key" | "x402";

export interface SynapPluginSettings {
  mode: ModeSetting;
  origin: string;
  port: number;
  maxPerCallUsd: number;
  /** Optional per-process budget for wallet payments; undefined = no total cap. */
  maxTotalUsd?: number;
  preferNetwork?: PayNetwork;
  wallet: WalletKeys;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function parseMode(raw: unknown): ModeSetting {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "x402" || v === "wallet") return "x402";
  if (v === "api-key" || v === "apikey" || v === "key") return "api-key";
  return "auto";
}

export function readSettings(pluginConfig: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv = process.env): SynapPluginSettings {
  const cfg = pluginConfig ?? {};
  const port = Number(cfg.port ?? env.SYNAP_PROXY_PORT);
  const total = Number(cfg.maxTotalUsd ?? env.SYNAP_MAX_TOTAL_USD);
  const walletInputs: Parameters<typeof resolveWalletKeys>[0] = { env };
  const wk = str(cfg.walletKey);
  if (wk) walletInputs.walletKey = wk;
  const sk = str(cfg.solanaKey);
  if (sk) walletInputs.solanaKey = sk;
  const settings: SynapPluginSettings = {
    mode: parseMode(cfg.mode ?? env.SYNAP_PAYMENT),
    origin: normalizeOrigin(str(cfg.origin) ?? str(env.SYNAP_ORIGIN) ?? DEFAULT_ORIGIN),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    maxPerCallUsd: parseMaxPerCallUsd(cfg.maxPerCallUsd ?? env.SYNAP_MAX_PER_CALL_USD),
    wallet: resolveWalletKeys(walletInputs),
  };
  if (Number.isFinite(total) && total > 0) settings.maxTotalUsd = total;
  const net = parsePreferredNetwork(cfg.preferNetwork ?? env.SYNAP_X402_NETWORK);
  if (net) settings.preferNetwork = net;
  return settings;
}

/** First API key found in the environment, by documented precedence. */
export function envApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of API_KEY_ENV_VARS) {
    const v = str(env[name]);
    if (v) return v;
  }
  return undefined;
}
