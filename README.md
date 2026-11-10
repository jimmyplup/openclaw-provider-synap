# openclaw-provider-synap

**[Synap by Linkrra](https://synap402.com)** as an [OpenClaw](https://openclaw.ai) model provider: open models on dedicated GPUs behind an OpenAI-compatible API.

- **Live catalog.** Model ids, context windows and per-token prices are read from `https://synap402.com/v1/models` at runtime, so new models show up without a plugin release.
- **Two ways to pay.** Use an **API key**, or pay **per call in USDC over [x402](https://x402.org)** (Base or Solana) from your own wallet with no account, through a local proxy the plugin runs.
- **Router included.** `synap/synap-v1` picks the cheapest model that can do the job and bills at that model's rate.

```bash
openclaw plugins install openclaw-provider-synap
openclaw onboard --synap-api-key sk-...
openclaw models set synap/synap-v1
```

## 30-second quickstart (API key)

1. Get a key at [synap402.com/account.html](https://synap402.com/account.html). Google sign-in includes a [free daily allowance](https://synap402.com/free.html).
2. Install the plugin and add the key:

   ```bash
   openclaw plugins install openclaw-provider-synap
   openclaw onboard --synap-api-key sk-...      # or: export SYNAP_API_KEY=sk-...
   openclaw gateway restart
   ```

3. Pick a model and test it:

   ```bash
   openclaw models list --all --provider synap
   openclaw models set synap/synap-v1
   openclaw agent --model synap/synap-v1 --message "Reply exactly: SYNAP_OK"
   ```

The key can also live in `LINKRRA_API_KEY`, or in an OpenClaw auth profile (`openclaw models auth login --provider synap`).

## Pay per call from a wallet (no account, no key)

The plugin starts a loopback proxy on `127.0.0.1:8419` together with the gateway. OpenClaw talks to the proxy, and the proxy pays Synap for each call in USDC from your wallet. The wallet key never leaves your machine; only signatures are sent.

```bash
openclaw plugins install openclaw-provider-synap
npx -y openclaw-provider-synap wallet new          # ~/.synap/wallet.key (0600); prints the address to fund
# send USDC on Base to that address (calls start at $0.001)
npx -y openclaw-provider-synap config --x402 --out synap-x402.json
openclaw config patch --file synap-x402.json --dry-run
openclaw config patch --file synap-x402.json
openclaw gateway restart
```

The generated patch:

- adds an explicit `models.providers.synap` entry that points at the loopback proxy;
- supplies the proxy's local token as a **file SecretRef** (`~/.synap/proxy.token`, mode 0600), so no secret is written into `openclaw.json`;
- sets `plugins.entries.synap.config.mode` to `x402` and makes `synap/synap-v1` the default model.

To use an existing wallet instead of creating one, set `SYNAP_WALLET_KEY` (Base, `0x...`) or `SYNAP_SOLANA_KEY` (Solana) in the gateway environment, or put `walletKey` / `solanaKey` in the plugin config.

Spending guard rails:

| Setting | Default | Effect |
| --- | --- | --- |
| `maxPerCallUsd` (`SYNAP_MAX_PER_CALL_USD`) | `0.10` | Per-call ceiling. The official x402 client checks it before signing, and a quote above it is refused, not paid. |
| `maxTotalUsd` (`SYNAP_MAX_TOTAL_USD`) | none | Spend budget per gateway run, reserved before each payment is signed so concurrent calls cannot overshoot it. Once it is reached, calls answer `402` until you restart. |

- Only USDC can be signed. A payment option that asks to stay valid for more than a day is refused, and paid calls never follow redirects.
- **Who can reach the proxy.** It listens on loopback only. It refuses requests that carry a browser `Origin` header or a non-loopback `Host`, so web pages cannot reach it, and it requires the bearer token from `~/.synap/proxy.token`, so other local programs cannot spend the wallet without reading that file.
- **What a call costs up front.** A quote prices the request's input plus its `max_tokens`. The plugin caps OpenClaw's output reservation at 8,192 tokens per call, which keeps standard-tier quotes well under the default ceiling. For premium models or very long contexts, raise `maxPerCallUsd`.
- **Receipts.** Each payment is logged with its amount, network and transaction hash.

### The proxy without OpenClaw

```bash
SYNAP_WALLET_KEY=0x... npx -y openclaw-provider-synap proxy
# OPENAI_BASE_URL=http://127.0.0.1:8419/v1
# OPENAI_API_KEY=<contents of ~/.synap/proxy.token>
```

Any OpenAI-compatible client (SDKs, LangChain, aider, ...) can then pay per call through it.

## Plugin config (`plugins.entries.synap.config`)

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto` (the API key when one is configured, else the wallet), `api-key`, or `x402`. |
| `walletKey` | `SYNAP_WALLET_KEY`, then `~/.synap/wallet.key` | EVM key that pays on Base. Marked sensitive. |
| `solanaKey` | `SYNAP_SOLANA_KEY`, then `~/.synap/solana.key` | Solana key that pays on Solana. Marked sensitive. |
| `preferNetwork` | `base` | Which chain to pay on when both wallets are set. |
| `maxPerCallUsd` | `0.10` | Per-call ceiling for wallet payments. |
| `maxTotalUsd` | none | Spend budget per gateway run. |
| `port` | `8419` | Loopback port of the proxy. |
| `origin` | `https://synap402.com` | Synap origin. |

## Commands

```bash
npx -y openclaw-provider-synap doctor            # mode, key/wallet sources, live models, proxy health; no secrets printed
npx -y openclaw-provider-synap wallet            # address(es) and Base USDC balance
npx -y openclaw-provider-synap wallet new        # create a Base wallet
npx -y openclaw-provider-synap config [--x402] [--out FILE]   # openclaw.json patch
npx -y openclaw-provider-synap proxy [--port N]  # run the x402 proxy alone
```

(`openclaw plugins install` does not link a package's CLI, hence `npx`.)

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No `synap/*` models | Check that the plugin is enabled (`openclaw plugins inspect synap`) and that a key or wallet is configured. `SYNAP_DEBUG=1` traces the provider's decisions to stderr. |
| `No API key found for provider "synap"` in wallet mode | Apply the `config --x402` patch: OpenClaw only sends a credential it can resolve, and the patch supplies the proxy token. |
| `402` from the proxy with `synap_unconfigured` | Set or create a wallet (`wallet new`), then restart the gateway. |
| "exceeds the per-call ceiling" | Raise `maxPerCallUsd`, or use a cheaper model or a shorter context. |
| An update did not take effect | `openclaw plugins install` keeps an existing install of the same version. Install the newer version, or uninstall first. |

## Compatibility

Tested with OpenClaw **2026.9.4**: install from a packed archive, a live inference probe, and full agent turns both with an API key and with x402 wallet payment through the proxy. Tested with **2026.11.2**: install, SDK registration, and a live inference probe. The plugin is built on the documented provider SDK (`defineSingleProviderPluginEntry`, `catalog.run`, `prepareDynamicModel` / `resolveDynamicModel`) plus a plugin service for the proxy.

## Development

```bash
npm install
npm test        # unit tests, plus a harness that loads the entry through an installed OpenClaw's SDK
npm run build
npm pack && openclaw plugins install npm-pack:./openclaw-provider-synap-0.1.0.tgz
```

MIT licensed. Links: [synap402.com](https://synap402.com) · [Models and prices](https://synap402.com/models.html) · [Docs](https://synap402.com/docs.html) · [x402 guide](https://synap402.com/guides/x402.html)
