import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { generatePrivateKey } from "viem/accounts";
import { dynamicModelRow, FALLBACK_CONTEXT_WINDOW, toOpenClawModels } from "../src/openclaw-models.ts";
import { parseModelList } from "../src/core/models.ts";
import { __resetForTests, activeProxy, createSynapProvider, registerSynapServices, runSynapCatalog, walletConfigPatch } from "../src/provider.ts";
import { readSettings } from "../src/settings.ts";
import { startFakeSeller, type FakeSeller } from "./helpers/fake-seller.ts";

const fixture = readFileSync(new URL("./fixtures/models.json", import.meta.url), "utf8");
const home = () => mkdtempSync(join(tmpdir(), "synap-plugin-"));

async function seller(): Promise<FakeSeller> {
  return startFakeSeller({
    extra: (req, res) => {
      if (req.path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixture);
        return true;
      }
      return false;
    },
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const ctx = (apiKey: string | undefined, env: NodeJS.ProcessEnv = {}) => ({ env, resolveProviderApiKey: () => ({ apiKey }) });

afterEach(() => __resetForTests());

test("toOpenClawModels: live prices per 1M tokens, vision input, safe defaults", () => {
  const rows = toOpenClawModels(parseModelList(JSON.parse(fixture)));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(rows[0]!.id, "synap-v1");
  assert.match(rows[0]!.name, /router/);
  assert.deepEqual(byId["qwen3-coder-30b"]!.cost, { input: 0.0675, output: 0.27, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(byId["qwen/qwen3-vl-30b-a3b-instruct"]!.input, ["text", "image"]);
  assert.equal(byId["qwen/qwen3-vl-30b-a3b-instruct"]!.contextWindow, 65536);
  assert.equal(byId["qwen/qwen3-vl-30b-a3b-instruct"]!.maxTokens, 8192);
  assert.equal(byId["deepseek/deepseek-v4-flash"]!.contextWindow, FALLBACK_CONTEXT_WINDOW);
  assert.deepEqual(byId["synap-v1"]!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(dynamicModelRow("acme/foo-vl-7b").input.includes("image"), true);
  assert.equal(dynamicModelRow("acme/foo").input.includes("image"), false);
});

test("catalog: API key -> direct Synap baseUrl, the key, and the live models", async () => {
  const s = await seller();
  try {
    const settings = readSettings({ origin: s.origin });
    const r = await runSynapCatalog(ctx("sk-test"), settings);
    assert.ok(r);
    assert.equal(r.provider.baseUrl, `${s.origin}/v1`);
    assert.equal(r.provider.apiKey, "sk-test");
    assert.equal(r.provider.api, "openai-completions");
    assert.equal(r.provider.models.length, 5);
    assert.equal(s.requests.find((q) => q.path === "/v1/models")!.headers.authorization, "Bearer sk-test");
  } finally {
    await s.close();
  }
});

test("catalog: wallet (no key) -> loopback proxy baseUrl and a 0600 proxy token", async () => {
  const s = await seller();
  try {
    const dir = home();
    const settings = readSettings({ origin: s.origin, walletKey: generatePrivateKey(), port: 9999 });
    const r = await runSynapCatalog(ctx(undefined, { SYNAP_HOME: dir }), settings);
    assert.ok(r);
    assert.equal(r.provider.baseUrl, "http://127.0.0.1:9999/v1");
    assert.match(r.provider.apiKey!, /^synap-local-/);
    assert.equal(r.provider.apiKey, readFileSync(join(dir, "proxy.token"), "utf8").trim());
    const forced = await runSynapCatalog(ctx("sk-ignored", { SYNAP_HOME: dir }), readSettings({ origin: s.origin, mode: "x402", port: 9999 }));
    assert.equal(forced!.provider.baseUrl, "http://127.0.0.1:9999/v1", "mode x402 ignores the key");
  } finally {
    await s.close();
  }
});

test("catalog: nothing configured, api-key mode without a key, or another provider -> null", async () => {
  const empty = home();
  assert.equal(await runSynapCatalog(ctx(undefined, { SYNAP_HOME: empty }), readSettings({}, { SYNAP_HOME: empty })), null);
  assert.equal(await runSynapCatalog(ctx(undefined), readSettings({ mode: "api-key", walletKey: generatePrivateKey() })), null);
  assert.equal(await runSynapCatalog({ ...ctx("k"), providerIds: ["openai"] }, readSettings({})), null);
});

test("catalog: a /v1/models outage keeps the provider with the router only", async () => {
  const warnings: string[] = [];
  const r = await runSynapCatalog(ctx("k"), readSettings({ origin: "http://127.0.0.1:1" }), (m) => warnings.push(m));
  assert.deepEqual(r!.provider.models.map((m) => m.id), ["synap-v1"]);
  assert.match(warnings[0]!, /could not read/);
});

test("provider object: id, env vars, API-key auth method, dynamic models", () => {
  const p = createSynapProvider({ pluginConfig: { origin: "https://synap402.com" } });
  assert.equal(p.id, "synap");
  assert.deepEqual(p.envVars, ["SYNAP_API_KEY", "LINKRRA_API_KEY"]);
  assert.equal(p.auth[0]!.flagName, "--synap-api-key");
  assert.equal(p.auth[0]!.defaultModel, "synap/synap-v1");
  assert.equal(p.docsPath, "https://synap402.com");
  const dyn = p.resolveDynamicModel({ modelId: "new/model-7b", providerConfig: { baseUrl: "https://synap402.com/v1" } });
  assert.equal(dyn.id, "new/model-7b");
  assert.equal(dyn.provider, "synap");
  assert.equal(dyn.baseUrl, "https://synap402.com/v1");
});

test("wallet config patch: explicit loopback provider, token via file SecretRef, no secret inline", () => {
  const patch = walletConfigPatch({ port: 8419, tokenPath: "/home/u/.synap/proxy.token", maxPerCallUsd: 0.05 });
  const provider = patch.models.providers.synap;
  assert.equal(provider.baseUrl, "http://127.0.0.1:8419/v1");
  assert.equal(provider.api, "openai-completions");
  assert.deepEqual(provider.apiKey, { source: "file", provider: "synap_proxy", id: "value" });
  assert.deepEqual(patch.secrets.providers.synap_proxy, { source: "file", path: "/home/u/.synap/proxy.token", mode: "singleValue" });
  assert.deepEqual(patch.plugins.entries.synap.config, { mode: "x402", maxPerCallUsd: 0.05 });
  assert.equal(patch.agents.defaults.model.primary, "synap/synap-v1");
  assert.doesNotMatch(JSON.stringify(patch), /synap-local-/);
});

test("dynamic resolution uses live price and context once the catalog has been read", async () => {
  const s = await seller();
  try {
    const p = createSynapProvider({ pluginConfig: { origin: s.origin } });
    const before = p.resolveDynamicModel({ modelId: "qwen3-coder-30b" });
    assert.equal(before.cost.input, 0, "no snapshot yet: conservative row");
    assert.equal(before.baseUrl, `${s.origin}/v1`);
    const prepared = await p.prepareDynamicModel({ modelId: "synap/qwen3-coder-30b" });
    assert.equal(prepared.id, "qwen3-coder-30b");
    assert.equal(prepared.cost.output, 0.27);
    assert.equal(prepared.contextWindow, 98304);
    assert.equal(p.resolveDynamicModel({ modelId: "qwen3-coder-30b" }).cost.input, 0.0675, "sync path now has the snapshot");
    assert.equal(p.resolveDynamicModel({ modelId: "brand-new-model" }).contextWindow, FALLBACK_CONTEXT_WINDOW);
  } finally {
    await s.close();
  }
});

test("service: not registered on discovery loads; on full loads it starts a paying proxy and stops cleanly", async () => {
  const s = await seller();
  const dir = home();
  const prevHome = process.env.SYNAP_HOME;
  process.env.SYNAP_HOME = dir;
  try {
    const services: Array<{ id: string; start: (c: unknown) => unknown; stop?: (c: unknown) => unknown }> = [];
    const api = (mode: string) => ({
      registrationMode: mode,
      pluginConfig: { origin: s.origin, walletKey: generatePrivateKey() },
      registerService: (svc: (typeof services)[number]) => services.push(svc),
      logger: { info: () => {}, warn: () => {} },
    });
    registerSynapServices(api("discovery"));
    assert.equal(services.length, 0);
    const port = await freePort();
    const full = api("full");
    full.pluginConfig = { ...full.pluginConfig, port } as typeof full.pluginConfig;
    registerSynapServices(full);
    assert.equal(services.length, 1);
    await services[0]!.start({});
    await services[0]!.start({}); // idempotent
    const p = activeProxy();
    assert.ok(p);
    assert.equal(p.port, port);
    assert.equal(p.mode, "x402");
    const token = readFileSync(join(dir, "proxy.token"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "synap/qwen3-coder-30b", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { model: string }).model, "qwen3-coder-30b", "provider prefix stripped before forwarding");
    assert.equal(s.verified[0]!.valid, true);
    await services[0]!.stop!({});
    assert.equal(activeProxy(), null);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  } finally {
    if (prevHome === undefined) delete process.env.SYNAP_HOME;
    else process.env.SYNAP_HOME = prevHome;
    await s.close();
  }
});
