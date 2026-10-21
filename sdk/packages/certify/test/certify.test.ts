import type { AddressInfo } from "node:net";
import type { AgentCard, DiscoveredAgent } from "@pistiva/agent-sdk";
import { signCard } from "@pistiva/agent-sdk";
import { createProviderGateway, type ProviderGatewayOptions } from "@pistiva/gateway";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePlatform, type FakeAgent } from "../../gateway/test/fake-platform.ts";
import { runConformance } from "../src/index.ts";

const QUOTE = { sku: "BOLT-M8-50", available: true, qty: 10, uom: "EA", unitPrice: "4.20", currency: "INR", validUntil: "2026-11-01", terms: "Net 30" };

describe("conformance suite", () => {
  let platform: FakePlatform;
  let certifier: FakeAgent;
  let partner: FakeAgent;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    platform = new FakePlatform();
    certifier = platform.registerAgent();
    partner = platform.registerAgent();
  });

  afterEach(() => app?.close());

  /** Starts a partner gateway and returns it as discovery would. */
  async function partnerAt(overrides: Partial<ProviderGatewayOptions> = {}, registered?: (card: AgentCard) => AgentCard): Promise<DiscoveredAgent> {
    const card: AgentCard = {
      agentId: partner.agentId,
      orgId: partner.orgId,
      kid: partner.kid,
      name: "Partner",
      version: "1.0.0",
      endpoint: "http://placeholder",
      protocols: ["a2a/0.3"],
      capabilities: [{ name: "quote.request", version: 1, description: "Quotes" }],
      issuedAt: 1,
    };
    app = createProviderGateway({
      agentId: partner.agentId,
      kid: partner.kid,
      keys: partner.keys,
      platform,
      card,
      capabilities: { "quote.request": { handle: () => ({ ...QUOTE, costPrice: "2.65" }) } },
      ...overrides,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    card.endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const onPlatform = registered ? registered(card) : card;
    return {
      agentId: partner.agentId,
      orgId: partner.orgId,
      orgName: "Partner",
      orgDomain: "partner.example.com",
      orgVerified: true,
      card: onPlatform,
      kid: partner.kid,
      signature: signCard(onPlatform, partner.keys),
      publicKey: partner.keys.publicKey,
    };
  }

  const run = (provider: DiscoveredAgent) =>
    runConformance({ platform: platform.clientFor(certifier, partner, ["sku", "available", "unitPrice", "currency"]), keys: certifier.keys, provider, capability: "quote.request" });

  it("passes a conforming partner on every check", async () => {
    const report = await run(await partnerAt());
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      "card.a2a",
      "card.trust-extension",
      "trust.requires-extension",
      "trust.bad-signature",
      "trust.expired",
      "trust.grant-scope",
      "trust.replay",
      "trust.task-access",
      "receipts.signed",
      "receipts.countersign",
      "contract.rejects-invalid",
      "contract.result",
      "disclosure.grant-fields",
      "idempotency.retry",
    ]);
    // The probes are real exchanges: the certifier's countersigned receipts reached the platform.
    expect(platform.receipts.length).toBeGreaterThanOrEqual(2);
  });

  it("fails a partner that accepts replayed messages", async () => {
    const report = await run(await partnerAt({ nonceStore: { firstUse: () => true } }));
    expect(report.passed).toBe(false);
    expect(report.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(["trust.replay"]);
  });

  it("fails a partner whose served card is not the one registered on the platform", async () => {
    const report = await run(await partnerAt({}, (card) => ({ ...card, name: "Someone else" })));
    expect(report.checks.find((c) => c.id === "card.trust-extension")).toMatchObject({ passed: false, detail: expect.stringContaining("differs from the card registered") });
  });

  it("fails a partner whose results break the contract", async () => {
    const report = await run(await partnerAt({ capabilities: { "quote.request": { handle: () => ({ sku: "X", available: true, unitPrice: 4.2 }) } } }));
    expect(report.checks.find((c) => c.id === "contract.result")).toMatchObject({ passed: false });
  });
});
