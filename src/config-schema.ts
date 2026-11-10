// Plugin config schema (plugins.entries.synap.config). The same JSON Schema is
// declared in openclaw.plugin.json; a test keeps the two identical.

export const CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: {
      type: "string",
      enum: ["auto", "api-key", "x402"],
      description:
        "auto (default): use an API key when one is configured, else pay per call from a wallet over x402. api-key: key only. x402: wallet only.",
    },
    walletKey: {
      type: "string",
      description: "EVM private key (0x + 64 hex) that pays in USDC on Base. Precedence: this, then SYNAP_WALLET_KEY, then ~/.synap/wallet.key.",
    },
    solanaKey: {
      type: "string",
      description: "Solana secret key (base58 or 64-byte JSON array) that pays in USDC on Solana. Precedence: this, then SYNAP_SOLANA_KEY, then ~/.synap/solana.key.",
    },
    preferNetwork: { type: "string", enum: ["base", "solana"], description: "Which chain to pay on when both wallets are set (default base)." },
    maxPerCallUsd: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Per-call ceiling in USD for wallet payments, checked before anything is signed (default 0.10).",
    },
    maxTotalUsd: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Optional spend budget in USD for wallet payments per gateway run. Unset means no total cap.",
    },
    port: { type: "integer", minimum: 1, maximum: 65535, description: "Loopback port of the local x402 proxy (default 8419)." },
    origin: { type: "string", description: "Synap origin (default https://synap402.com)." },
  },
} as const;

export const CONFIG_UI_HINTS = {
  walletKey: { label: "Base wallet key", sensitive: true, placeholder: "0x... (optional; pays per call in USDC on Base)" },
  solanaKey: { label: "Solana wallet key", sensitive: true, placeholder: "base58 secret key (optional)" },
  mode: { label: "Payment mode" },
  maxPerCallUsd: { label: "Max USD per call" },
  maxTotalUsd: { label: "Spend budget (USD)" },
} as const;

type Issue = { path: Array<string | number>; message: string };
type ParseResult = { success: true; data: unknown } | { success: false; error: { issues: Issue[] } };

/** Validates a config value against CONFIG_JSON_SCHEMA (the small subset it uses). */
export function safeParseConfig(value: unknown): ParseResult {
  if (value === undefined) return { success: true, data: undefined };
  const issues: Issue[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { success: false, error: { issues: [{ path: [], message: "expected config object" }] } };
  }
  const props = CONFIG_JSON_SCHEMA.properties as Record<string, { type: string; enum?: readonly string[]; minimum?: number; maximum?: number; exclusiveMinimum?: number }>;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const spec = props[key];
    if (!spec) {
      issues.push({ path: [key], message: "unknown property" });
      continue;
    }
    if (spec.type === "string") {
      if (typeof v !== "string") issues.push({ path: [key], message: "expected string" });
      else if (spec.enum && !spec.enum.includes(v)) issues.push({ path: [key], message: `expected one of ${spec.enum.join(", ")}` });
    } else if (spec.type === "number" || spec.type === "integer") {
      if (typeof v !== "number" || !Number.isFinite(v) || (spec.type === "integer" && !Number.isInteger(v))) {
        issues.push({ path: [key], message: `expected ${spec.type}` });
      } else if ((spec.minimum !== undefined && v < spec.minimum) || (spec.maximum !== undefined && v > spec.maximum) || (spec.exclusiveMinimum !== undefined && v <= spec.exclusiveMinimum)) {
        issues.push({ path: [key], message: "out of range" });
      }
    }
  }
  return issues.length ? { success: false, error: { issues } } : { success: true, data: value };
}

export const configSchema = { safeParse: safeParseConfig, jsonSchema: CONFIG_JSON_SCHEMA, uiHints: CONFIG_UI_HINTS };
