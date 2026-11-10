// Regression for ClawHub scan 2026-11-10 (plugin 0.1.0 marked suspicious): concurrent paid
// requests could each pass the total-budget check before any payment was recorded, so the
// combined signed payments could exceed maxTotalUsd. The budget is now reserved in the signer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey } from "viem/accounts";
import { parseModelList } from "../src/core/models.ts";
import { createPayFetch } from "../src/core/x402.ts";
import { startProxy } from "../src/proxy.ts";
import { startFakeSeller } from "./helpers/fake-seller.ts";

const TOKEN = "synap-local-" + "b".repeat(32);
const models = parseModelList({ data: [{ id: "synap-v1", routing: "auto" }] });
const completion = { "content-type": "application/json" };

test("concurrent calls through the signer never sign past maxTotalUsd", async () => {
  // $0.05 per call, $0.10 budget: at most 2 of 6 simultaneous calls may be signed.
  const seller = await startFakeSeller({ amount: "50000" });
  try {
    const pay = await createPayFetch({ keys: { evm: generatePrivateKey() }, origin: seller.origin, maxPerCallUsd: 0.1, maxTotalUsd: 0.1 });
    assert.ok(pay);
    const call = () =>
      pay.fetch(`${seller.origin}/api/billing/x402/chat/completions`, { method: "POST", headers: completion, body: JSON.stringify({ model: "m", messages: [] }) }).then(
        (r) => r.status,
        (e: Error) => e.message,
      );
    const results = await Promise.all(Array.from({ length: 6 }, call));
    assert.equal(results.filter((r) => r === 200).length, 2, JSON.stringify(results));
    assert.equal(results.filter((r) => typeof r === "string" && /spend budget reached/.test(r)).length, 4, JSON.stringify(results));
    assert.equal(seller.verified.length, 2);
    assert.equal(pay.payments.length, 2);
    assert.ok(pay.totalUsd() <= 0.1 + 1e-12);
    assert.ok(Math.abs(pay.committedUsd() - pay.totalUsd()) < 1e-12, "no reservation may leak after the calls settle");
  } finally {
    await seller.close();
  }
});

test("concurrent calls through the proxy stop at the budget with 402, not 502", async () => {
  const seller = await startFakeSeller({ amount: "50000" });
  const pay = await createPayFetch({ keys: { evm: generatePrivateKey() }, origin: seller.origin, maxPerCallUsd: 0.1, maxTotalUsd: 0.1 });
  const p = await startProxy({ origin: seller.origin, payFetch: pay, token: TOKEN, listModels: async () => models, userAgent: "t", maxTotalUsd: 0.1 });
  try {
    const call = () =>
      fetch(`${p.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
    const res = await Promise.all(Array.from({ length: 6 }, call));
    const statuses = res.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 2, JSON.stringify(statuses));
    assert.equal(statuses.filter((s) => s === 402).length, 4, JSON.stringify(statuses));
    for (const r of res) {
      if (r.status !== 402) continue;
      assert.equal(((await r.json()) as { error: { code: string } }).error.code, "synap_budget_reached");
    }
    assert.equal(seller.verified.length, 2);
    assert.ok(p.stats().spentUsd <= 0.1 + 1e-12);
  } finally {
    await p.close();
    await seller.close();
  }
});

test("a refused quote reserves nothing from the budget", async () => {
  // Quote above the per-call ceiling: refused before any reservation, budget stays whole.
  const seller = await startFakeSeller({ amount: "500000" });
  try {
    const pay = await createPayFetch({ keys: { evm: generatePrivateKey() }, origin: seller.origin, maxPerCallUsd: 0.1, maxTotalUsd: 0.1 });
    assert.ok(pay);
    await assert.rejects(pay.fetch(`${seller.origin}/api/billing/x402/chat/completions`, { method: "POST", headers: completion, body: "{}" }), /maxAmountPerPayment|per-call ceiling/);
    assert.equal(pay.committedUsd(), 0);
    assert.equal(seller.verified.length, 0);
  } finally {
    await seller.close();
  }
});
