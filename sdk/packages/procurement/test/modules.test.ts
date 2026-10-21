import type { GrantClaims } from "@pistiva/agent-sdk";
import type { TaskContext } from "@pistiva/gateway";
import { describe, expect, it } from "vitest";
import { MemoryDraftStore, orderConfirmCapability, orderDraftCapability } from "../src/index.ts";

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
