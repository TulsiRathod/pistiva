import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CsvFileInventory, JsonFileInventory, type InventoryConnector, type InventoryItem } from "@pistiva/procurement";
import type { ConnectorConfig } from "./config.ts";

/**
 * Inventory behind an MCP server (an ERP or inventory system exposing a lookup tool). The server
 * runs locally over stdio, so the business's data stays on its own machines. Credentials for the
 * ERP belong in the MCP server's environment, never in a prompt or a message to a peer.
 */
export class McpInventory implements InventoryConnector {
  readonly kind = "mcp";
  private client?: Promise<Client>;

  constructor(private readonly cfg: Extract<ConnectorConfig, { type: "mcp" }>) {}

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const transport = new StdioClientTransport({
        command: this.cfg.command,
        args: this.cfg.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(this.cfg.env ?? {}) },
      });
      const client = new Client({ name: "pistiva-partner-kit", version: "0.1.0" });
      await client.connect(transport);
      return client;
    })();
    this.client.catch(() => (this.client = undefined));
    return this.client;
  }

  async find(sku: string): Promise<InventoryItem | undefined> {
    const client = await this.connect();
    const res = await client.callTool({ name: this.cfg.tool, arguments: { sku } });
    if (res.isError) throw new Error(`MCP tool ${this.cfg.tool} failed`);
    const structured = (res as { structuredContent?: unknown }).structuredContent;
    if (structured && typeof structured === "object" && "sku" in structured) return structured as InventoryItem;
    const text = (res.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
    const parsed = text ? JSON.parse(text) : null;
    return parsed ?? undefined;
  }

  async health() {
    try {
      const client = await this.connect();
      const { tools } = await client.listTools();
      const ok = tools.some((t) => t.name === this.cfg.tool);
      return ok ? { ok, detail: `${tools.length} tools` } : { ok, detail: `tool ${this.cfg.tool} not found` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async close() {
    const c = await this.client?.catch(() => undefined);
    await c?.close();
  }
}

export function buildConnector(cfg: ConnectorConfig): InventoryConnector {
  switch (cfg.type) {
    case "json-file":
      return new JsonFileInventory(cfg.path);
    case "csv-file":
      return new CsvFileInventory(cfg.path);
    case "mcp":
      return new McpInventory(cfg);
    default:
      throw new Error(`Unknown connector type ${(cfg as { type: string }).type}`);
  }
}
