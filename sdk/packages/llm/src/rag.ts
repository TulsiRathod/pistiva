import { createHash } from "node:crypto";
import type { CatalogHit } from "./modules.ts";

/** The slice of a Postgres client the index needs (pg.Pool satisfies it). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface Embedder {
  readonly name: string;
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic, model-free embeddings: hashed word and character-trigram features, L2-normalised.
 * Good enough for SKU and product-name lookups, and lets RAG run with no model at all.
 */
export class HashEmbedder implements Embedder {
  readonly name = "hash";

  constructor(readonly dims = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const words = norm.split(" ").filter(Boolean);
    const features = [...words, ...words.flatMap((w) => (w.length < 3 ? [w] : Array.from({ length: w.length - 2 }, (_, i) => `#${w.slice(i, i + 3)}`)))];
    for (const f of features) {
      const h = createHash("sha1").update(f).digest();
      const idx = h.readUInt32BE(0) % this.dims;
      v[idx]! += h[4]! & 1 ? 1 : -1;
    }
    const len = Math.hypot(...v) || 1;
    return v.map((x) => x / len);
  }
}

/** Local embeddings through Ollama (e.g. nomic-embed-text), keeping catalog text on the business's machines. */
export class OllamaEmbedder implements Embedder {
  readonly name: string;

  constructor(
    readonly dims = 768,
    private readonly model = "nomic-embed-text",
    private readonly baseUrl = "http://localhost:11434",
  ) {
    this.name = `ollama-${model.replace(/[^a-z0-9]+/gi, "_")}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`);
    return ((await res.json()) as { embeddings: number[][] }).embeddings;
  }
}

export interface Chunk {
  id: string;
  source: string;
  ref: string;
  content: string;
}

export interface SearchHit extends Chunk {
  score: number;
}

const RRF_K = 60;

/**
 * Hybrid retrieval over the node's own documents (catalog items, specs, past orders) in its own
 * Postgres: full-text rank and pgvector cosine distance, fused with reciprocal rank fusion.
 * An optional reranker can reorder the fused list; it is off by default.
 */
export class CatalogIndex {
  private readonly table: string;
  private ready?: Promise<void>;

  constructor(
    private readonly db: Queryable,
    private readonly embedder: Embedder,
    private readonly rerank?: (query: string, hits: SearchHit[]) => Promise<SearchHit[]>,
  ) {
    this.table = `rag_chunks_${embedder.name.replace(/[^a-z0-9_]/gi, "_")}_${embedder.dims}`.toLowerCase();
  }

  private ensure(): Promise<void> {
    this.ready ??= (async () => {
      await this.db.query("CREATE EXTENSION IF NOT EXISTS vector");
      await this.db.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        ref TEXT NOT NULL,
        content TEXT NOT NULL,
        tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
        embedding VECTOR(${this.embedder.dims}) NOT NULL
      )`);
      await this.db.query(`CREATE INDEX IF NOT EXISTS ${this.table}_tsv ON ${this.table} USING GIN (tsv)`);
      await this.db.query(`CREATE INDEX IF NOT EXISTS ${this.table}_vec ON ${this.table} USING hnsw (embedding vector_cosine_ops)`);
    })();
    this.ready.catch(() => (this.ready = undefined));
    return this.ready;
  }

  async upsert(chunks: Chunk[]): Promise<number> {
    await this.ensure();
    if (!chunks.length) return 0;
    const vectors = await this.embedder.embed(chunks.map((c) => c.content));
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      await this.db.query(
        `INSERT INTO ${this.table} (id, source, ref, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)
         ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, ref = EXCLUDED.ref, content = EXCLUDED.content, embedding = EXCLUDED.embedding`,
        [c.id, c.source, c.ref, c.content, `[${vectors[i]!.join(",")}]`],
      );
    }
    return chunks.length;
  }

  /** Removes chunks of a source that are not in `keepIds` (e.g. items deleted from the catalog). */
  async prune(source: string, keepIds: string[]): Promise<void> {
    await this.ensure();
    await this.db.query(`DELETE FROM ${this.table} WHERE source = $1 AND NOT (id = ANY($2))`, [source, keepIds]);
  }

  async search(query: string, opts: { k?: number; source?: string } = {}): Promise<SearchHit[]> {
    await this.ensure();
    const k = opts.k ?? 5;
    const [vector] = await this.embedder.embed([query]);
    const where = opts.source ? "AND source = $3" : "";
    const params = (first: unknown) => (opts.source ? [first, 25, opts.source] : [first, 25]);
    const semantic = await this.db.query(
      `SELECT id, source, ref, content FROM ${this.table} WHERE TRUE ${where} ORDER BY embedding <=> $1::vector LIMIT $2`,
      params(`[${vector!.join(",")}]`),
    );
    const lexical = await this.db.query(
      `SELECT id, source, ref, content FROM ${this.table}
       WHERE tsv @@ plainto_tsquery('simple', $1) ${where}
       ORDER BY ts_rank(tsv, plainto_tsquery('simple', $1)) DESC LIMIT $2`,
      params(query),
    );
    const fused = new Map<string, SearchHit>();
    for (const list of [semantic.rows, lexical.rows]) {
      list.forEach((row: Chunk, rank: number) => {
        const hit = fused.get(row.id) ?? { ...row, score: 0 };
        hit.score += 1 / (RRF_K + rank + 1);
        fused.set(row.id, hit);
      });
    }
    let hits = [...fused.values()].sort((a, b) => b.score - a.score);
    if (this.rerank) hits = await this.rerank(query, hits);
    return hits.slice(0, k);
  }

  /** Convenience for catalog lookups: hits as SKU + name. */
  async searchCatalog(query: string, k = 3): Promise<CatalogHit[]> {
    return (await this.search(query, { k, source: "catalog" })).map((h) => ({ sku: h.ref, name: h.content.split("\n")[0]!, score: h.score }));
  }
}
