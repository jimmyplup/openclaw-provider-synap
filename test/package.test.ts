// Packaging invariants: manifest, package.json, config schema, shared core.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIG_JSON_SCHEMA, CONFIG_UI_HINTS, safeParseConfig } from "../src/config-schema.ts";
import { DEFAULT_PORT, PLUGIN_ID, PROVIDER_ID } from "../src/settings.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const manifest = JSON.parse(read("../openclaw.plugin.json"));
const pkg = JSON.parse(read("../package.json"));

test("manifest and package.json agree on ids and entry points", () => {
  assert.equal(manifest.id, PLUGIN_ID);
  assert.deepEqual(manifest.providers, [PROVIDER_ID]);
  assert.deepEqual(pkg.openclaw.providers, [PROVIDER_ID]);
  assert.deepEqual(pkg.openclaw.extensions, ["./dist/index.js"]);
  assert.ok(pkg.files.includes("openclaw.plugin.json"));
  assert.ok(pkg.openclaw.compat.pluginApi, "compat.pluginApi is required for ClawHub");
  assert.ok(pkg.openclaw.build.openclawVersion, "build.openclawVersion is required for ClawHub");
  assert.deepEqual(manifest.setup.providers[0].envVars, ["SYNAP_API_KEY", "LINKRRA_API_KEY"]);
  const choice = manifest.providerAuthChoices[0];
  assert.equal(choice.provider, PROVIDER_ID);
  assert.equal(choice.method, "api-key");
  assert.ok(choice.optionKey && choice.cliFlag.startsWith("--") && choice.choiceLabel, "complete api-key choice");
});

test("manifest configSchema / uiHints are exactly the runtime ones", () => {
  assert.deepEqual(manifest.configSchema, JSON.parse(JSON.stringify(CONFIG_JSON_SCHEMA)));
  assert.deepEqual(manifest.uiHints, JSON.parse(JSON.stringify(CONFIG_UI_HINTS)));
  assert.match(manifest.configSchema.properties.port.description, new RegExp(String(DEFAULT_PORT)));
});

test("runtime config validation", () => {
  assert.equal(safeParseConfig(undefined).success, true);
  assert.equal(safeParseConfig({ mode: "x402", maxPerCallUsd: 0.05, port: 9000, preferNetwork: "solana" }).success, true);
  for (const bad of [{ mode: "free" }, { port: 0 }, { port: 1.5 }, { maxPerCallUsd: 0 }, { walletKey: 1 }, { unknown: true }, []]) {
    assert.equal(safeParseConfig(bad).success, false, JSON.stringify(bad));
  }
});

test("shared core is byte-identical to synap-mcp's copy (when both are checked out)", () => {
  for (const f of ["models.ts", "x402.ts"]) {
    const sibling = new URL(`../../synap-mcp/src/core/${f}`, import.meta.url);
    if (!existsSync(sibling)) continue;
    assert.equal(read(`../src/core/${f}`), readFileSync(sibling, "utf8"), `src/core/${f} drifted from synap-mcp`);
  }
});

test("public text never points at the pool host or mentions mining", () => {
  for (const f of ["../README.md", "../openclaw.plugin.json", "../package.json", "../src/provider.ts", "../src/cli.ts", "../src/proxy.ts", "../src/core/x402.ts", "../src/core/models.ts"]) {
    if (!existsSync(new URL(f, import.meta.url))) continue;
    const text = read(f);
    assert.doesNotMatch(text, /pool\.linkrra\.com/i, f);
    assert.doesNotMatch(text, /\bPRL\b|\bmining\b|\bminer\b/i, f);
  }
});
