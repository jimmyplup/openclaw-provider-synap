// x402 wallet payment for Synap: pay per call in USDC on Base or Solana with
// no account and no API key. Built on the official x402 v2 client libraries
// (@x402/fetch, @x402/evm, @x402/svm), loaded lazily so key-only users never
// pay their import cost.
//
// SHARED FILE: byte-identical copies live in synap-mcp/src/core/ and
// openclaw-provider-synap/src/core/ (a test in each package fails on drift).
//
// Safety model:
// - Keys never leave the machine; only signatures are sent.
// - A per-call ceiling (default $0.10) is enforced by the x402 client's own
//   spend controls BEFORE anything is signed, and only USDC (a default asset)
//   can be signed at all.
// - A payment option asking to stay valid for more than a day is refused.
// - The paying fetch only talks to the configured Synap origin and never
//   follows redirects, so a signature cannot be steered to another host.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeOrigin } from "./models.ts";

export const X402_CHAT_PATH = "/api/billing/x402/chat/completions";
export const BASE_CAIP2 = "eip155:8453";
export const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const DEFAULT_BASE_RPC = "https://mainnet.base.org";
export const DEFAULT_MAX_PER_CALL_USD = 0.1;
export const MAX_VALIDITY_SECONDS = 86_400;

export type PayNetwork = "base" | "solana";

export interface WalletKeys {
  /** EVM private key (0x + 64 hex) used on Base. */
  evm?: `0x${string}`;
  /** Solana secret key: base58 string or a JSON byte array (solana-keygen format). */
  solana?: string;
  sources: { evm?: string; solana?: string };
}

export interface WalletKeyInputs {
  env?: NodeJS.ProcessEnv;
  walletKey?: string;
  solanaKey?: string;
  /** Directory holding wallet.key / solana.key. Default: $SYNAP_HOME or ~/.synap */
  dir?: string;
}

export function walletDir(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SYNAP_HOME && env.SYNAP_HOME.trim()) || join(homedir(), ".synap");
}

export function normalizeEvmKey(raw: string | undefined): `0x${string}` | undefined {
  const v = (raw ?? "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v as `0x${string}`;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return `0x${v}`;
  return undefined;
}

export function normalizeSolanaKey(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  if (v.startsWith("[")) {
    try {
      const arr = JSON.parse(v) as unknown;
      if (Array.isArray(arr) && arr.length === 64 && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return v;
    } catch {
      return undefined;
    }
    return undefined;
  }
  return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v) ? v : undefined;
}

function readKeyFile(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Precedence for each chain: explicit config > environment > key file in the wallet dir. */
export function resolveWalletKeys(inputs: WalletKeyInputs = {}): WalletKeys {
  const env = inputs.env ?? process.env;
  const dir = inputs.dir ?? walletDir(env);
  const keys: WalletKeys = { sources: {} };
  const evmCandidates: Array<[string | undefined, string]> = [
    [inputs.walletKey, "config"],
    [env.SYNAP_WALLET_KEY, "SYNAP_WALLET_KEY"],
    [readKeyFile(join(dir, "wallet.key")), join(dir, "wallet.key")],
  ];
  for (const [raw, source] of evmCandidates) {
    const k = normalizeEvmKey(raw);
    if (k) {
      keys.evm = k;
      keys.sources.evm = source;
      break;
    }
  }
  const solCandidates: Array<[string | undefined, string]> = [
    [inputs.solanaKey, "config"],
    [env.SYNAP_SOLANA_KEY, "SYNAP_SOLANA_KEY"],
    [readKeyFile(join(dir, "solana.key")), join(dir, "solana.key")],
  ];
  for (const [raw, source] of solCandidates) {
    const k = normalizeSolanaKey(raw);
    if (k) {
      keys.solana = k;
      keys.sources.solana = source;
      break;
    }
  }
  return keys;
}

export const hasWallet = (k: WalletKeys): boolean => Boolean(k.evm || k.solana);

/** Positive USD amount, else the default. Malformed input never disables the ceiling. */
export function parseMaxPerCallUsd(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PER_CALL_USD;
}

export function parsePreferredNetwork(raw: unknown): PayNetwork | undefined {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "base" || v === BASE_CAIP2) return "base";
  if (v === "solana" || v === "sol" || v === SOLANA_CAIP2) return "solana";
  return undefined;
}

interface Requirement {
  scheme?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
}

/** USD value of a USDC payment requirement, or undefined for any other asset. */
export function requirementUsd(r: Requirement): number | undefined {
  const asset = String(r.asset ?? "");
  const isUsdc = asset.toLowerCase() === USDC_BASE.toLowerCase() || asset === USDC_SOLANA;
  const raw = r.amount ?? r.maxAmountRequired;
  if (!isUsdc || typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  return Number(raw) / 1e6;
}

/** Picks the requirement to pay: preferred network first, then Base, then Solana, among those we can sign. */
export function selectRequirement<T extends Requirement>(accepts: T[], canPay: string[], prefer?: PayNetwork): T {
  const usable = accepts.filter((a) => a.scheme === "exact" && canPay.includes(String(a.network)));
  const order = prefer === "solana" ? [SOLANA_CAIP2, BASE_CAIP2] : [BASE_CAIP2, SOLANA_CAIP2];
  for (const net of order) {
    const hit = usable.find((a) => a.network === net);
    if (hit) return hit;
  }
  const fallback = usable[0] ?? accepts[0];
  if (!fallback) throw new Error("Synap offered no payment option this wallet can pay");
  return fallback;
}

export interface PaymentRecord {
  network: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  amountUsd?: number;
  at: string;
}

export interface PayFetch {
  fetch: typeof globalThis.fetch;
  /** CAIP-2 networks this wallet can pay on. */
  networks: string[];
  addresses: { base?: string; solana?: string };
  maxPerCallUsd: number;
  /** Payments signed so far by this process (most recent last). */
  payments: PaymentRecord[];
  totalUsd(): number;
}

export interface CreatePayFetchOptions {
  keys: WalletKeys;
  origin?: string;
  maxPerCallUsd?: number;
  preferNetwork?: PayNetwork;
  baseFetch?: typeof globalThis.fetch;
  /** Solana RPC for building the transfer (default: the x402 SVM client's mainnet RPC). */
  solanaRpcUrl?: string;
  onPayment?: (p: PaymentRecord) => void;
}

const SOLANA_HINT = "Solana payments need @x402/svm and @solana/kit installed";
const EVM_HINT = "Base payments need @x402/evm and viem installed";

async function solanaSignerFromKey(secret: string): Promise<{ signer: unknown; address: string }> {
  const kit = (await import("@solana/kit")) as typeof import("@solana/kit");
  const bytes = secret.startsWith("[")
    ? new Uint8Array(JSON.parse(secret) as number[])
    : new Uint8Array(kit.getBase58Encoder().encode(secret));
  const signer = await kit.createKeyPairSignerFromBytes(bytes);
  return { signer, address: String(signer.address) };
}

/**
 * Builds a fetch that answers Synap's HTTP 402 by signing an x402 payment
 * from the configured wallet(s) and retrying. Returns null when no wallet
 * key is configured.
 */
export async function createPayFetch(opts: CreatePayFetchOptions): Promise<PayFetch | null> {
  const { keys } = opts;
  if (!hasWallet(keys)) return null;
  const origin = normalizeOrigin(opts.origin);
  const maxPerCallUsd = parseMaxPerCallUsd(opts.maxPerCallUsd);
  const baseFetch = opts.baseFetch ?? globalThis.fetch;
  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");

  const networks: string[] = [];
  const addresses: PayFetch["addresses"] = {};
  const registrations: Array<(client: InstanceType<typeof x402Client>) => void> = [];

  if (keys.evm) {
    let evm: { registerExactEvmScheme: typeof import("@x402/evm/exact/client").registerExactEvmScheme };
    let viemAccounts: typeof import("viem/accounts");
    let toClientEvmSigner: typeof import("@x402/evm").toClientEvmSigner;
    try {
      evm = await import("@x402/evm/exact/client");
      ({ toClientEvmSigner } = await import("@x402/evm"));
      viemAccounts = await import("viem/accounts");
    } catch (e) {
      throw new Error(`${EVM_HINT}: ${(e as Error).message}`);
    }
    const account = viemAccounts.privateKeyToAccount(keys.evm);
    addresses.base = account.address;
    networks.push(BASE_CAIP2);
    registrations.push((client) => {
      evm.registerExactEvmScheme(client, { signer: toClientEvmSigner(account), networks: [BASE_CAIP2] });
    });
  }

  if (keys.solana) {
    let svm: typeof import("@x402/svm/exact/client");
    let signerInfo: { signer: unknown; address: string };
    try {
      svm = await import("@x402/svm/exact/client");
      signerInfo = await solanaSignerFromKey(keys.solana);
    } catch (e) {
      throw new Error(`${SOLANA_HINT}, and SYNAP_SOLANA_KEY must be a base58 secret key or a 64-byte JSON array: ${(e as Error).message}`);
    }
    addresses.solana = signerInfo.address;
    networks.push(SOLANA_CAIP2);
    registrations.push((client) => {
      svm.registerExactSvmScheme(client, {
        signer: signerInfo.signer as Parameters<typeof svm.registerExactSvmScheme>[1]["signer"],
        networks: [SOLANA_CAIP2],
      });
    });
  }

  const client = new x402Client((_version, accepts) => selectRequirement(accepts as Requirement[], networks, opts.preferNetwork) as never);
  // Official spend controls: only default assets (USDC) and at most maxPerCallUsd per payment.
  client.setSpendControls({ maxAmountPerPayment: `$${maxPerCallUsd}` });
  for (const register of registrations) register(client);

  const payments: PaymentRecord[] = [];
  client.onBeforePaymentCreation(async (ctx) => {
    const req = ctx.selectedRequirements as Requirement;
    const validity = Number(req.maxTimeoutSeconds ?? 0);
    if (validity > MAX_VALIDITY_SECONDS) {
      return { abort: true, reason: `payment option asks to stay valid ${validity}s (> ${MAX_VALIDITY_SECONDS}s); not signed` };
    }
    const usd = requirementUsd(req);
    if (usd === undefined || usd > maxPerCallUsd) {
      return { abort: true, reason: `quote ${usd === undefined ? "in an unknown asset" : `$${usd}`} exceeds the per-call ceiling $${maxPerCallUsd} (SYNAP_MAX_PER_CALL_USD)` };
    }
    return undefined;
  });
  client.onAfterPaymentCreation(async (ctx) => {
    const req = ctx.selectedRequirements as Requirement;
    const rec: PaymentRecord = {
      network: String(req.network),
      asset: String(req.asset),
      payTo: String(req.payTo),
      amountAtomic: String(req.amount ?? req.maxAmountRequired ?? ""),
      at: new Date().toISOString(),
    };
    const usd = requirementUsd(req);
    if (usd !== undefined) rec.amountUsd = usd;
    payments.push(rec);
    opts.onPayment?.(rec);
  });

  const paying = wrapFetchWithPayment(baseFetch, client);
  const guarded: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${origin}/`)) throw new Error(`x402 wallet refuses to pay a host other than ${origin}`);
    return paying(input, { ...init, redirect: "manual" });
  };

  return {
    fetch: guarded,
    networks,
    addresses,
    maxPerCallUsd,
    payments,
    totalUsd: () => payments.reduce((s, p) => s + (p.amountUsd ?? 0), 0),
  };
}

export interface Settlement {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
}

/** Decodes the PAYMENT-RESPONSE settlement receipt header, if present. */
export function readSettlement(headers: Headers): Settlement | undefined {
  const raw = headers.get("payment-response") ?? headers.get("x-payment-response");
  if (!raw) return undefined;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    const out: Settlement = {};
    if (typeof json.success === "boolean") out.success = json.success;
    if (typeof json.transaction === "string") out.transaction = json.transaction;
    if (typeof json.network === "string") out.network = json.network;
    if (typeof json.payer === "string") out.payer = json.payer;
    return out;
  } catch {
    return undefined;
  }
}

/** Generates a fresh EVM wallet into <dir>/wallet.key (0600). Never overwrites an existing key. */
export async function createEvmWallet(dir: string = walletDir()): Promise<{ address: string; path: string; created: boolean }> {
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const path = join(dir, "wallet.key");
  const existing = normalizeEvmKey(readKeyFile(path));
  if (existing) return { address: privateKeyToAccount(existing).address, path, created: false };
  if (existsSync(path)) throw new Error(`${path} exists but is not a valid key; refusing to overwrite it`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pk = generatePrivateKey();
  writeFileSync(path, `${pk}\n`, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return { address: privateKeyToAccount(pk).address, path, created: true };
}

/** USDC balance (in dollars) of an address on Base. Read-only. */
export async function readBaseUsdcBalance(address: string, rpcUrl: string = DEFAULT_BASE_RPC): Promise<number> {
  const { createPublicClient, http, erc20Abi } = await import("viem");
  const { base } = await import("viem/chains");
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const bal = await pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] });
  return Number(bal) / 1e6;
}
