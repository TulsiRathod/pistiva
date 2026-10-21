/**
 * Example MCP server standing in for an ERP: exposes a `lookup_sku` tool over stdio.
 * Point a Partner Kit connector at it with:
 *   connectors:
 *     erp: { type: mcp, command: npx, args: [tsx, examples/mcp-inventory-server.ts], tool: lookup_sku }
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const file = process.env.INVENTORY_FILE ?? fileURLToPath(new URL("../data/inventory.json", import.meta.url));
const server = new McpServer({ name: "example-erp-inventory", version: "0.1.0" });

server.registerTool(
  "lookup_sku",
  { description: "Look up one inventory record by SKU. Returns null when the SKU is not stocked.", inputSchema: { sku: z.string() } },
  async ({ sku }) => {
    const items = JSON.parse(await readFile(file, "utf8")) as { sku: string }[];
    return { content: [{ type: "text", text: JSON.stringify(items.find((i) => i.sku === sku) ?? null) }] };
  },
);

await server.connect(new StdioServerTransport());
