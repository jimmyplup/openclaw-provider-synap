// A local stand-in for Synap's x402 door: answers 402 with a real x402 v2
// PAYMENT-REQUIRED challenge (same shape Synap sends), then verifies the
// EIP-3009 signature on the retry with viem before answering 200.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyTypedData } from "viem";

export const PAY_TO = "0x00000000000000000000000000000000000000AA";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface SellerRequest {
  path: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface FakeSeller {
  origin: string;
  requests: SellerRequest[];
  verified: Array<{ from: string; value: string; valid: boolean }>;
  close(): Promise<void>;
}

export interface FakeSellerOptions {
  /** Atomic USDC amount quoted (default 1000 = $0.001). */
  amount?: string;
  maxTimeoutSeconds?: number;
  /** Extra route handler; return true when handled. */
  extra?: (req: SellerRequest, res: import("node:http").ServerResponse) => boolean;
  completion?: (body: Record<string, unknown>) => Record<string, unknown>;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

export async function startFakeSeller(opts: FakeSellerOptions = {}): Promise<FakeSeller> {
  const requests: SellerRequest[] = [];
  const verified: FakeSeller["verified"] = [];
  let origin = "";
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r: SellerRequest = { path: req.url ?? "/", method: req.method ?? "GET", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    requests.push(r);
    if (opts.extra?.(r, res)) return;
    if (r.method === "POST" && (r.path === "/api/billing/x402/chat/completions" || r.path === "/v1/chat/completions")) {
      const requirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: opts.amount ?? "1000",
        asset: USDC,
        payTo: PAY_TO,
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 120,
        extra: { name: "USD Coin", version: "2" },
      };
      const sig = req.headers["payment-signature"];
      if (!sig) {
        const challenge = {
          x402Version: 2,
          error: "PAYMENT-SIGNATURE header is required",
          resource: { url: `${origin}${r.path}`, description: "test", mimeType: "application/json" },
          accepts: [requirements],
        };
        res.writeHead(402, { "content-type": "application/json", "payment-required": b64(challenge) });
        res.end(JSON.stringify(challenge));
        return;
      }
      const payload = JSON.parse(Buffer.from(String(sig), "base64").toString("utf8")) as {
        payload: { signature: `0x${string}`; authorization: Record<string, string> };
      };
      const a = payload.payload.authorization;
      const valid = await verifyTypedData({
        address: a.from as `0x${string}`,
        domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: a.from as `0x${string}`,
          to: a.to as `0x${string}`,
          value: BigInt(a.value!),
          validAfter: BigInt(a.validAfter!),
          validBefore: BigInt(a.validBefore!),
          nonce: a.nonce as `0x${string}`,
        },
        signature: payload.payload.signature,
      });
      verified.push({ from: String(a.from), value: String(a.value), valid });
      if (!valid || a.to?.toLowerCase() !== PAY_TO.toLowerCase()) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ x402Version: 2, error: "invalid signature", accepts: [requirements] }));
        return;
      }
      const body = JSON.parse(r.body || "{}") as Record<string, unknown>;
      const completion = opts.completion?.(body) ?? {
        id: "chatcmpl-test",
        object: "chat.completion",
        model: String(body.model ?? "test-model"),
        choices: [{ index: 0, message: { role: "assistant", content: "paid answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
      res.writeHead(200, {
        "content-type": "application/json",
        "payment-response": b64({ success: true, transaction: "0xfeedbeef", network: "eip155:8453", payer: a.from }),
      });
      res.end(JSON.stringify(completion));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route ${r.method} ${r.path}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    verified,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
