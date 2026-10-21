import type { ContractRegistry } from "@pistiva/agent-sdk";
import type { CapabilityHandler } from "@pistiva/gateway";
import { orderConfirmCapability, orderDraftCapability, quoteCapability, type DraftStore, type InventoryConnector, type QuoteOptions } from "@pistiva/procurement";
import type { KitConfig } from "./config.ts";
import type { KitRepo } from "./repo.ts";

/** Built-in agent modules, by the name agents.yaml refers to them. */
type ModuleFactory = (ctx: { connector?: InventoryConnector; options: Record<string, unknown>; drafts: DraftStore }) => CapabilityHandler;

export const MODULES: Record<string, ModuleFactory> = {
  "inventory-quote": ({ connector, options }) => {
    if (!connector) throw new Error("inventory-quote needs a connector");
    return quoteCapability(connector, options as QuoteOptions);
  },
  "order-draft": ({ drafts, options }) => orderDraftCapability(drafts, (options.holdDays as number | undefined) ?? 3),
  "order-confirm": ({ drafts, options }) => orderConfirmCapability(drafts, (options.shipInDays as number | undefined) ?? 5),
};

export const disclosureKey = (capability: string) => `disclosure:${capability}`;

/**
 * Builds the handlers for every task type the node provides. Each handler's disclosure list is
 * read from the operator's settings at call time, so a change in the UI applies to the next round
 * without a restart. The list can only narrow what the contract's result schema allows.
 */
export async function buildCapabilities(
  cfg: KitConfig,
  deps: { connectors: Record<string, InventoryConnector>; drafts: DraftStore; repo: KitRepo; contracts: ContractRegistry; versionOf: (capability: string) => number },
): Promise<{ handlers: Record<string, CapabilityHandler>; disclosure: Map<string, string[]> }> {
  const handlers: Record<string, CapabilityHandler> = {};
  const disclosure = new Map<string, string[]>();
  for (const [capability, p] of Object.entries(cfg.provides)) {
    const factory = MODULES[p.module];
    if (!factory) throw new Error(`Unknown module ${p.module} for ${capability}; available: ${Object.keys(MODULES).join(", ")}`);
    const handler = factory({ connector: p.connector ? deps.connectors[p.connector] : undefined, options: p.options ?? {}, drafts: deps.drafts });
    const contractFields = await deps.contracts.resultFields(capability, deps.versionOf(capability));
    const saved = await deps.repo.getSetting<string[]>(disclosureKey(capability));
    const initial = (saved ?? handler.responseFields ?? contractFields).filter((f) => contractFields.includes(f));
    disclosure.set(capability, initial);
    handlers[capability] = Object.defineProperty(handler, "responseFields", {
      get: () => disclosure.get(capability),
      enumerable: true,
      configurable: true,
    });
  }
  return { handlers, disclosure };
}
