#!/usr/bin/env node
// openclaw-provider-synap <command>
//   doctor        show what is configured and whether Synap answers (no secrets printed)
//   wallet        wallet address(es) and Base USDC balance
//   wallet new    create a Base wallet at ~/.synap/wallet.key (0600)
//   proxy         run the x402 proxy alone, for any OpenAI-compatible client
//   config        print the openclaw.json snippet for this plugin
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchModels } from "./core/models.ts";
import { createEvmWallet, createPayFetch, hasWallet, readBaseUsdcBalance, walletDir } from "./core/x402.ts";
import { DEFAULT_MODEL_REF, USER_AGENT, VERSION, walletConfigPatch, walletPathEnabled } from "./provider.ts";
import { loadProxyToken, startProxy } from "./proxy.ts";
import { envApiKey, PLUGIN_ID, readSettings } from "./settings.ts";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

const HELP = `openclaw-provider-synap ${VERSION} - Synap by Linkrra for OpenClaw (https://synap402.com)

  doctor        check configuration and the live API
  wallet        show wallet address(es) and Base USDC balance
  wallet new    create a Base wallet at ~/.synap/wallet.key (0600)
  proxy [--port N]
                run the x402 pay-per-call proxy alone (any OpenAI client)
  config [--x402] [--out FILE]
                print the openclaw.json snippet (API key or wallet mode)
`;

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<number | undefined> {
  const [cmd, sub] = args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    out(VERSION);
    return 0;
  }
  const s = readSettings(undefined);

  if (cmd === "doctor") {
    out(`openclaw-provider-synap ${VERSION}`);
    out(`origin:      ${s.origin}`);
    out(`mode:        ${s.mode}`);
    out(`api key:     ${envApiKey() ? "present in env" : "not in env (an OpenClaw auth profile may still hold one)"}`);
    out(`wallet:      ${s.wallet.evm ? `Base (${s.wallet.sources.evm})` : "no Base key"}; ${s.wallet.solana ? `Solana (${s.wallet.sources.solana})` : "no Solana key"}`);
    out(`x402 proxy:  ${walletPathEnabled(s) ? `http://127.0.0.1:${s.port}/v1, ceiling $${s.maxPerCallUsd}/call` : "off"}`);
    try {
      const models = await fetchModels({ origin: s.origin, userAgent: USER_AGENT });
      out(`models:      ${models.length} live; default ${DEFAULT_MODEL_REF}`);
    } catch (e) {
      out(`models:      UNREACHABLE (${(e as Error).message})`);
      return 1;
    }
    if (walletPathEnabled(s)) {
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/health`, { signal: AbortSignal.timeout(2000) });
        const h = (await r.json()) as { mode?: string; paidCalls?: number; spentUsd?: number };
        out(`proxy:       running (${h.mode}; ${h.paidCalls ?? 0} paid calls, $${h.spentUsd ?? 0} this run)`);
      } catch {
        out("proxy:       not running (it starts with the OpenClaw gateway, or run `openclaw-provider-synap proxy`)");
      }
    }
    return 0;
  }

  if (cmd === "wallet") {
    if (sub === "new") {
      const w = await createEvmWallet(walletDir());
      out(w.created ? "Created a Base wallet." : "A wallet already exists; not replacing it.");
      out(`address: ${w.address}`);
      out(`key:     ${w.path} (0600; back it up, it is the only copy)`);
      out("Fund it with USDC on Base (calls start at $0.001), then restart the OpenClaw gateway.");
      return 0;
    }
    if (!hasWallet(s.wallet)) {
      err("No wallet configured. Run `openclaw-provider-synap wallet new`, or set SYNAP_WALLET_KEY / SYNAP_SOLANA_KEY.");
      return 2;
    }
    const pf = await createPayFetch({ keys: s.wallet, origin: s.origin, maxPerCallUsd: s.maxPerCallUsd });
    if (pf?.addresses.base) {
      out(`Base:   ${pf.addresses.base}`);
      try {
        out(`        USDC balance $${(await readBaseUsdcBalance(pf.addresses.base)).toFixed(6)}`);
      } catch (e) {
        out(`        balance unreadable (${(e as Error).message.slice(0, 120)})`);
      }
    }
    if (pf?.addresses.solana) out(`Solana: ${pf.addresses.solana}`);
    return 0;
  }

  if (cmd === "proxy") {
    const port = Number(opt(args, "--port")) || s.port;
    const payOpts: Parameters<typeof createPayFetch>[0] = { keys: s.wallet, origin: s.origin, maxPerCallUsd: s.maxPerCallUsd };
    if (s.preferNetwork) payOpts.preferNetwork = s.preferNetwork;
    const payFetch = await createPayFetch(payOpts);
    const token = loadProxyToken(walletDir());
    const proxyOpts: Parameters<typeof startProxy>[0] = {
      origin: s.origin,
      payFetch,
      token,
      port,
      userAgent: USER_AGENT,
      listModels: () => fetchModels({ origin: s.origin, userAgent: USER_AGENT }),
      log: (m) => err(`[synap] ${m}`),
    };
    if (s.maxTotalUsd !== undefined) proxyOpts.maxTotalUsd = s.maxTotalUsd;
    const p = await startProxy(proxyOpts);
    out(`OPENAI_BASE_URL=${p.baseUrl}/v1`);
    out(`OPENAI_API_KEY=<contents of ${walletDir()}/proxy.token>`);
    if (!payFetch) err("No wallet configured: calls will answer 402 until you set one (wallet new).");
    await new Promise(() => {});
  }

  if (cmd === "config") {
    const x402 = args.includes("--x402");
    let snippet: unknown;
    if (x402) {
      const dir = walletDir();
      loadProxyToken(dir); // create the 0600 token file the SecretRef points at
      snippet = walletConfigPatch({ port: Number(opt(args, "--port")) || s.port, tokenPath: join(dir, "proxy.token"), maxPerCallUsd: s.maxPerCallUsd });
    } else {
      snippet = {
        plugins: { entries: { [PLUGIN_ID]: { enabled: true } } },
        agents: { defaults: { model: { primary: DEFAULT_MODEL_REF } } },
      };
    }
    const json = JSON.stringify(snippet, null, 2);
    const file = opt(args, "--out");
    if (file) {
      writeFileSync(file, `${json}\n`, { mode: 0o600 });
      err(`wrote ${file}; apply with: openclaw config patch --file ${file} --dry-run, then without --dry-run`);
    } else out(json);
    if (!x402) err("API key: export SYNAP_API_KEY=... or run `openclaw onboard --synap-api-key <key>`.");
    else if (!hasWallet(s.wallet)) err("No wallet yet: run `openclaw-provider-synap wallet new` and fund it with USDC on Base.");
    return 0;
  }

  err(`unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}

function invokedDirectly(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== undefined) process.exit(code);
    },
    (e: unknown) => {
      err(`openclaw-provider-synap: ${(e as Error)?.message ?? e}`);
      process.exit(1);
    },
  );
}
