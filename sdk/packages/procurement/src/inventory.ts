import { readFile } from "node:fs/promises";

/** A supplier's private inventory record. Only what the gateway's allowlist permits ever leaves. */
export interface InventoryItem {
  sku: string;
  name: string;
  stockOnHand: number;
  listPrice: string;
  costPrice?: string;
  warehouse?: string;
  supplierNotes?: string;
}

/**
 * Read access to the business's own inventory system. Implementations run inside the business's
 * infrastructure; the network only ever sees the quote a module derives from a record.
 */
export interface InventoryConnector {
  readonly kind: string;
  find(sku: string): Promise<InventoryItem | undefined>;
  /** Cheap reachability check for the operator UI. */
  health(): Promise<{ ok: boolean; items?: number; detail?: string }>;
}

export class ArrayInventory implements InventoryConnector {
  readonly kind = "memory";

  constructor(private readonly items: InventoryItem[]) {}

  async find(sku: string) {
    return this.items.find((i) => i.sku === sku);
  }

  async health() {
    return { ok: true, items: this.items.length };
  }
}

/** Reads a JSON array of InventoryItem; re-read on every lookup so edits apply without a restart. */
export class JsonFileInventory implements InventoryConnector {
  readonly kind = "json-file";

  constructor(private readonly path: string) {}

  private async load(): Promise<InventoryItem[]> {
    const items = JSON.parse(await readFile(this.path, "utf8"));
    if (!Array.isArray(items)) throw new Error(`${this.path} must contain a JSON array`);
    return items as InventoryItem[];
  }

  async find(sku: string) {
    return (await this.load()).find((i) => i.sku === sku);
  }

  async health() {
    try {
      return { ok: true, items: (await this.load()).length };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

/** Reads a CSV export with a header row: sku,name,stockOnHand,listPrice[,costPrice,warehouse,supplierNotes]. */
export class CsvFileInventory implements InventoryConnector {
  readonly kind = "csv-file";

  constructor(private readonly path: string) {}

  private async load(): Promise<InventoryItem[]> {
    const lines = (await readFile(this.path, "utf8")).split(/\r?\n/).filter((l) => l.trim());
    const [header, ...rows] = lines;
    if (!header) return [];
    const cols = parseCsvLine(header).map((c) => c.trim());
    for (const required of ["sku", "name", "stockOnHand", "listPrice"]) {
      if (!cols.includes(required)) throw new Error(`${this.path} is missing the ${required} column`);
    }
    return rows.map((line) => {
      const cells = parseCsvLine(line);
      const rec = Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? "").trim()]));
      return {
        sku: rec.sku!,
        name: rec.name!,
        stockOnHand: Number(rec.stockOnHand),
        listPrice: rec.listPrice!,
        costPrice: rec.costPrice || undefined,
        warehouse: rec.warehouse || undefined,
        supplierNotes: rec.supplierNotes || undefined,
      };
    });
  }

  async find(sku: string) {
    return (await this.load()).find((i) => i.sku === sku);
  }

  async health() {
    try {
      return { ok: true, items: (await this.load()).length };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

/** Minimal RFC 4180 line parser: commas inside double quotes, "" as an escaped quote. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
