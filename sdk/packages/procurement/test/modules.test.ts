import type { GrantClaims } from "@pistiva/agent-sdk";
import type { TaskContext } from "@pistiva/gateway";
import { describe, expect, it } from "vitest";
import { ArrayInventory, MemoryDraftStore, orderConfirmCapability, orderDraftCapability, quoteCapability } from "../src/index.ts";

function ctx(requester: string, grant: Partial<GrantClaims> = {}): TaskContext {
  return {
    taskId: "t1",
    requesterAgentId: requester,
    requesterOrgId: "org",
    round: 1,
    memory: {},
    grant: { bud: "5000.00", cur: "INR", apr: false, fld: [], ...grant } as GrantClaims,
  };
}

async function heldDraft(store: MemoryDraftStore, requester = "buyer") {
  const r = (await orderDraftCapability(store).handle!({ quoteTaskId: "q1", sku: "NUT-M8", qty: 1000, unitPrice: "1.10", currency: "INR" }, ctx(requester))) as {
    orderRef: string;
    total: string;
  };
  return r;
}

describe("quote.request clarifications from the AI hooks", () => {
  const inventory = new ArrayInventory([
    { sku: "BOLT-M8-50", name: "Hex bolt M8 x 50 mm, zinc", stockOnHand: 1000, listPrice: "4.20", costPrice: "2.65" },
  ]);

  it("offers similar catalog items for a SKU it doesn't stock, then quotes the one chosen", async () => {
    const quote = quoteCapability(inventory, { catalog: async () => [{ sku: "BOLT-M8-50", name: "Hex bolt M8 x 50 mm, zinc" }] });
    const c = ctx("buyer");
    const first = await quote.start!({ sku: "M8-BOLT", qty: 10 }, c);
    expect(first).toMatchObject({ state: "input-required", clarification: { field: "sku", options: ["BOLT-M8-50", "none of these"] } });
    expect(await quote.resume!({ answer: "BOLT-M8-50" }, c)).toMatchObject({ state: "completed", result: { sku: "BOLT-M8-50", qty: 10 } });
  });

  it("asks before quoting an item that conflicts with the buyer's specs", async () => {
    const quote = quoteCapability(inventory, { specCheck: async () => ({ matches: false, concern: "It is zinc plated, not stainless." }) });
    const c = ctx("buyer");
    const first = await quote.start!({ sku: "BOLT-M8-50", qty: 10, specs: "A2 stainless" }, c);
    expect(first).toMatchObject({ state: "input-required", clarification: { options: ["quote as is", "cancel"] } });
    expect(await quote.resume!({ answer: "quote as is" }, c)).toMatchObject({ state: "completed" });

    const c2 = ctx("buyer");
    await quote.start!({ sku: "BOLT-M8-50", qty: 10, specs: "A2 stainless" }, c2);
    expect(await quote.resume!({ answer: "cancel" }, c2)).toMatchObject({ state: "rejected" });
  });

  it("quotes normally when the AI hook fails", async () => {
    const quote = quoteCapability(inventory, { specCheck: async () => { throw new Error("model down"); } });
    expect(await quote.start!({ sku: "BOLT-M8-50", qty: 10, specs: "zinc" }, ctx("buyer"))).toMatchObject({ state: "completed" });
  });
});

describe("order.confirm", () => {
  it("confirms a held draft once, within the grant's budget", async () => {
    const store = new MemoryDraftStore();
    const { orderRef, total } = await heldDraft(store);
    expect(total).toBe("1100.00");
    const confirm = orderConfirmCapability(store);
    expect(await confirm.start!({ orderRef }, ctx("buyer"))).toMatchObject({ state: "completed", result: { orderRef, status: "confirmed" } });
    expect((await store.get(orderRef))?.status).toBe("confirmed");
    expect(await confirm.start!({ orderRef }, ctx("buyer"))).toMatchObject({ state: "rejected", reason: "Order is already confirmed" });
  });

  it("refuses a commitment grant that needed an approval but carries none", async () => {
    const store = new MemoryDraftStore();
    const { orderRef } = await heldDraft(store);
    const confirm = orderConfirmCapability(store);
    expect(await confirm.start!({ orderRef }, ctx("buyer", { apr: true }))).toMatchObject({ state: "rejected" });
    expect(await confirm.start!({ orderRef }, ctx("buyer", { apr: true, apv: "approval-1" }))).toMatchObject({ state: "completed" });
  });

  it("refuses another requester's draft and a grant smaller than the order", async () => {
    const store = new MemoryDraftStore();
    const { orderRef } = await heldDraft(store);
    const confirm = orderConfirmCapability(store);
    expect(await confirm.start!({ orderRef }, ctx("someone-else"))).toMatchObject({ state: "rejected", reason: "No such draft order for this requester" });
    expect(await confirm.start!({ orderRef }, ctx("buyer", { bud: "100.00" }))).toMatchObject({ state: "rejected" });
    expect(await confirm.start!({ orderRef: "DRAFT-NOPE" }, ctx("buyer"))).toMatchObject({ state: "rejected" });
  });
});
