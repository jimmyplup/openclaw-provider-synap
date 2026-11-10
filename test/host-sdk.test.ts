// Loads the real plugin entry (src/index.ts) through the real OpenClaw SDK
// (defineSingleProviderPluginEntry) from an installed host, and checks what it
// registers. Skipped when no OpenClaw install is found.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const dir = process.env.OPENCLAW_DIR ?? "/opt/homebrew/lib/node_modules/openclaw";
const hostVersion = existsSync(`${dir}/package.json`) ? (JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { version: string }).version : undefined;

test(`plugin entry registers through the host SDK (OpenClaw ${hostVersion ?? "not found"})`, { skip: !hostVersion && "OpenClaw not installed; set OPENCLAW_DIR" }, async () => {
  // Resolve `openclaw/*` against the installed host, the way OpenClaw links
  // itself into an installed plugin's node_modules.
  const hostParent = pathToFileURL(`${dir}/package.json`).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "openclaw" || specifier.startsWith("openclaw/")) return next(specifier, { ...context, parentURL: hostParent });
      return next(specifier, context);
    },
  });
  const entry = (await import("../src/index.ts")).default as {
    id: string;
    configSchema: { safeParse: (v: unknown) => { success: boolean } };
    register: (api: unknown) => void;
  };
  assert.equal(entry.id, "synap");
  assert.equal(entry.configSchema.safeParse({ mode: "x402" }).success, true);
  assert.equal(entry.configSchema.safeParse({ nope: 1 }).success, false);

  const providers: Array<Record<string, unknown>> = [];
  const catalogs: Array<Record<string, unknown>> = [];
  const services: unknown[] = [];
  entry.register({
    registrationMode: "full",
    pluginConfig: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerProvider: (p: Record<string, unknown>) => providers.push(p),
    registerModelCatalogProvider: (c: Record<string, unknown>) => catalogs.push(c),
    registerService: (s: unknown) => services.push(s),
  });
  assert.equal(providers.length, 1);
  const p = providers[0]!;
  assert.equal(p.id, "synap");
  assert.equal(p.label, "Synap by Linkrra");
  assert.deepEqual(p.envVars, ["SYNAP_API_KEY", "LINKRRA_API_KEY"]);
  const auth = p.auth as Array<{ id: string; kind: string; run: unknown; wizard?: { choiceId?: string } }>;
  assert.equal(auth.length, 1, "the SDK built a real API-key auth method");
  assert.equal(auth[0]!.id, "api-key");
  assert.equal(typeof auth[0]!.run, "function");
  assert.equal(typeof (p.catalog as { run: unknown }).run, "function");
  assert.equal(typeof p.resolveDynamicModel, "function");
  assert.deepEqual(catalogs.map((c) => c.provider), ["synap"]);
  assert.equal(services.length, 1, "x402 proxy service registered on full loads");

  const result = (await (p.catalog as { run: (ctx: unknown) => Promise<unknown> }).run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "sk-host-test" }),
    resolveProviderAuth: () => ({ apiKey: "sk-host-test", mode: "api_key", source: "env" }),
  })) as { provider: { baseUrl: string; models: Array<{ id: string }> } };
  assert.equal(result.provider.baseUrl, "https://synap402.com/v1");
  assert.ok(result.provider.models.length >= 1);
});
