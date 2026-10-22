import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { ContractRegistry, singleDataPart, type AgentCard, type AgentKeyPair, type PlatformClient } from "@pistiva/agent-sdk";
import { createProviderGateway, type RoundRecord } from "@pistiva/gateway";
import type { LlmProvider } from "@pistiva/llm";
import type { InventoryConnector } from "@pistiva/procurement";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { OperatorAuth } from "./auth.ts";
import type { KitConfig } from "./config.ts";
import { NodeAi } from "./ai.ts";
import { CommitmentService } from "./commitments.ts";
import { JobQueue } from "./jobs.ts";
import { buildConnector, McpInventory } from "./connectors.ts";
import { migrate, type Db } from "./db.ts";
import { buildCapabilities, disclosureKey } from "./modules.ts";
import { OutboundService, summarize, type OutboundRequest } from "./outbound.ts";
import { PeerListener, PeerTransport } from "@pistiva/p2p";
import { KitMetrics } from "./metrics.ts";
import { KitRepo, PgAuditSink, PgDraftStore, PgNonceStore, PgRoundStore, PgTaskStore, type Direction } from "./repo.ts";

export interface KitDeps {
  cfg: KitConfig;
  db: Db;
  platform: PlatformClient;
  keys: AgentKeyPair;
  agentId: string;
  orgId: string;
  kid: string;
  publicUrl: string;
  adminPassword: string;
  sessionSecret?: string;
  /** Publish the signed agent card on start (off in tests that use a fake platform). */
  publishCard?: boolean;
  /** Overrides the model from agents.yaml (tests, or a provider built elsewhere). */
  llmProvider?: LlmProvider;
  /** How often to check approvals the node is waiting on (default 5 s). */
  approvalPollMs?: number;
  /** How often maintenance jobs run: question deadlines, stalled tasks, receipt re-submission (default 60 s). */
  maintenanceMs?: number;
  /** Bearer token a Prometheus scraper sends to GET /metrics; without one the endpoint is off. */
  metricsToken?: string;
  /** Directory of the built operator UI; served when present. */
  webDir?: string;
  logger?: boolean;
}

export interface Kit {
  app: FastifyInstance;
  repo: KitRepo;
  outbound: OutboundService;
  commitments: CommitmentService;
  jobs: JobQueue;
  metrics: KitMetrics;
  close(): Promise<void>;
}

const DEFAULT_WEB_DIR = fileURLToPath(new URL("../web/dist", import.meta.url));

/**
 * A Pistiva node for one business: the provider gateway (A2A, verification, disclosure, receipts),
 * an outbound requester, its own database, and an operator API + UI. Nothing here is deployed by
 * the platform; the platform reaches this node only as an authenticated A2A peer.
 */
export async function createKit(deps: KitDeps): Promise<Kit> {
  const { cfg, db, platform } = deps;
  await migrate(db);
  const repo = new KitRepo(db);
  const contracts = new ContractRegistry(platform);
  const connectors: Record<string, InventoryConnector> = Object.fromEntries(Object.entries(cfg.connectors).map(([n, c]) => [n, buildConnector(c)]));
  const versionOf = (capability: string) => cfg.provides[capability]?.version ?? 1;
  const ai = new NodeAi(cfg.ai ?? {}, { db, contracts, provider: deps.llmProvider });
  const { handlers, disclosure } = await buildCapabilities(cfg, { connectors, drafts: new PgDraftStore(db), repo, contracts, versionOf, hooks: ai.quoteHooks() });
  // Index the catalog for "did you mean" lookups. A failure here only disables search, never the node.
  if (ai.index) await ai.reindex(connectors).catch((e: Error) => console.warn(`Catalog indexing failed: ${e.message}`));

  const card: AgentCard = {
    agentId: deps.agentId,
    orgId: deps.orgId,
    kid: deps.kid,
    name: cfg.agent.name,
    version: cfg.agent.version ?? "0.1.0",
    endpoint: deps.publicUrl,
    protocols: ["a2a/0.3", "pistiva-envelope/1"],
    capabilities: Object.entries(cfg.provides).map(([name, p]) => ({
      name,
      version: versionOf(name),
      description: p.description ?? name,
      responseFields: disclosure.get(name),
    })),
    issuedAt: Math.floor(Date.now() / 1000),
  };
  if (deps.publishCard !== false && card.capabilities.length) await platform.publishCard(card);

  const jobs = new JobQueue(db);
  const metrics = new KitMetrics(new Set([...Object.keys(cfg.provides), ...cfg.requests]), { jobs, repo });
  const peerTransport = cfg.p2p?.enabled ? new PeerTransport({ platform, keys: deps.keys, forceRelay: cfg.p2p.forceRelay }) : undefined;
  const outbound = new OutboundService({ platform, keys: deps.keys, repo, jobs, metrics, transport: peerTransport, suggest: (input) => ai.suggest(input) });
  const commitments = new CommitmentService({ db, repo, outbound, platform });
  jobs.register("approvals.poll", () => commitments.poll());
  jobs.every("approvals.poll", deps.approvalPollMs ?? 5000);
  const nonces = new PgNonceStore(db);
  const roundStore = new PgRoundStore(db);
  jobs.register("nonces.prune", () => nonces.prune().then(() => undefined));
  jobs.register("rounds.prune", () => roundStore.prune().then(() => undefined));
  for (const kind of ["questions.expire", "outbound.recover", "receipts.resubmit", "nonces.prune", "rounds.prune"]) jobs.every(kind, deps.maintenanceMs ?? 60_000);
  jobs.start();
  const app = createProviderGateway({
    agentId: deps.agentId,
    kid: deps.kid,
    keys: deps.keys,
    platform,
    card,
    description: cfg.agent.description,
    contracts,
    capabilities: handlers,
    taskStore: new PgTaskStore(db),
    nonceStore: nonces,
    roundStore,
    audit: metrics.auditSink(new PgAuditSink(db)),
    logger: deps.logger,
    onRound: (r) => recordInbound(repo, metrics, r),
    onCountersigned: (signed) => repo.saveReceipt(signed.receipt.taskId, signed, { countersigned: true }),
  });

  app.get("/metrics", async (req, reply) => {
    const expected = deps.metricsToken ? Buffer.from(`Bearer ${deps.metricsToken}`) : undefined;
    const given = Buffer.from(req.headers.authorization ?? "");
    if (!expected) return reply.code(404).send({ error: "not_found" });
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply.code(401).send({ error: "unauthorized" });
    return reply.header("Content-Type", metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  // Providers answer WebRTC offers through the same gateway, so every check applies to them too.
  const peerListener = cfg.p2p?.enabled
    ? new PeerListener({ platform, keys: deps.keys, app, forceRelay: cfg.p2p.forceRelay, onError: (e) => app.log.warn({ err: e }, "p2p") })
    : undefined;
  peerListener?.start();

  registerOperatorApi(app, { repo, outbound, commitments, ai, jobs, cfg, contracts, disclosure, connectors, versionOf, auth: new OperatorAuth(deps.adminPassword, deps.sessionSecret), deps });

  const webDir = deps.webDir ?? DEFAULT_WEB_DIR;
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.method === "GET" && !req.url.startsWith("/ui/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not_found" }),
    );
  }

  return {
    app,
    repo,
    outbound,
    commitments,
    jobs,
    metrics,
    async close() {
      jobs.stop();
      await peerListener?.stop();
      await peerTransport?.close();
      await outbound.idle();
      await app.close();
      await Promise.all(Object.values(connectors).map((c) => (c instanceof McpInventory ? c.close() : undefined)));
    },
  };
}

async function recordInbound(repo: KitRepo, metrics: KitMetrics, r: RoundRecord): Promise<void> {
  const data = singleDataPart(r.reply?.parts);
  const text = r.reply?.parts.find((p) => p.kind === "text");
  const existing = await repo.getTask(r.taskId);
  metrics.round("inbound", r.capability, r.state, existing?.createdAt ?? new Date().toISOString());
  if (r.state === "completed") metrics.disclosure(r.capability, Object.keys(data ?? {}).length, r.fieldsWithheld.length);
  await repo.upsertTask({
    id: r.taskId,
    direction: "inbound",
    peerAgentId: r.requesterAgentId,
    peerName: `agent ${r.requesterAgentId.slice(0, 8)}`,
    capability: r.capability,
    taskTypeVersion: r.taskTypeVersion,
    state: r.state,
    rounds: r.round,
    summary: summarize(r.capability, data),
  });
  await repo.addMessage(r.taskId, { round: r.round, sender: "peer", kind: r.kind, data: r.request });
  await repo.addMessage(r.taskId, {
    round: r.round,
    sender: "us",
    kind: r.state === "input-required" ? "clarification" : "result",
    state: r.state,
    data: data ?? (text?.kind === "text" ? { reason: text.text } : null),
    withheld: r.fieldsWithheld,
  });
  await repo.saveReceipt(r.taskId, r.receipt, { countersigned: false });
}

function registerOperatorApi(
  app: FastifyInstance,
  ctx: {
    repo: KitRepo;
    outbound: OutboundService;
    commitments: CommitmentService;
    ai: NodeAi;
    jobs: JobQueue;
    cfg: KitConfig;
    contracts: ContractRegistry;
    disclosure: Map<string, string[]>;
    connectors: Record<string, InventoryConnector>;
    versionOf: (c: string) => number;
    auth: OperatorAuth;
    deps: KitDeps;
  },
) {
  const { repo, outbound, cfg, auth } = ctx;
  const bearer = (req: FastifyRequest) => req.headers.authorization?.replace(/^Bearer\s+/i, "");

  app.post("/ui/login", async (req, reply) => {
    const result = auth.attempt(req.ip, (req.body as { password?: string })?.password ?? "");
    if (result.throttled) return reply.code(429).send({ error: "too_many_requests", message: "Too many failed sign-ins; try again in a few minutes" });
    return result.token ? { token: result.token } : reply.code(401).send({ error: "unauthorized", message: "Wrong password" });
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/ui/") && req.url !== "/ui/login" && !auth.verify(bearer(req))) {
      return reply.code(401).send({ error: "unauthorized", message: "Sign in to the node first" });
    }
  });

  app.get("/ui/me", async () => ({
    agent: { name: cfg.agent.name, agentId: ctx.deps.agentId, orgId: ctx.deps.orgId, publicUrl: ctx.deps.publicUrl },
    provides: Object.keys(cfg.provides),
    requests: cfg.requests,
    outbound: cfg.outbound ?? {},
    counts: await repo.counts(),
  }));

  app.get("/ui/tasks", async (req) => {
    const direction = (req.query as { direction?: Direction }).direction;
    return repo.listTasks(direction === "inbound" || direction === "outbound" ? direction : undefined);
  });

  app.get("/ui/tasks/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = await repo.getTask(id);
    if (!task) return reply.code(404).send({ error: "not_found", message: "No such task" });
    return { task, messages: await repo.messages(id), receipts: await repo.receipts(id), commitment: (await ctx.commitments.forDraft(id)) ?? null };
  });

  app.get("/ui/commitments", async () => ctx.commitments.list());

  /** Commit a held draft: confirm directly, or via a human approval when the platform requires one. */
  app.post("/ui/tasks/:id/commit", async (req, reply) => {
    try {
      return await ctx.commitments.commit((req.params as { id: string }).id);
    } catch (e) {
      return reply.code(409).send({ error: "conflict", message: (e as Error).message });
    }
  });

  app.get("/ui/questions", async (req) => repo.questions(((req.query as { status?: string }).status as "open") ?? "open"));

  app.post("/ui/questions/:id/answer", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { answer?: string; decline?: boolean };
    if (!body?.decline && !body?.answer?.trim()) return reply.code(400).send({ error: "bad_request", message: "answer is required" });
    const ok = await outbound.answer(id, body.decline ? null : body.answer!.trim());
    return ok ? { ok } : reply.code(409).send({ error: "conflict", message: "This question is no longer waiting for an answer" });
  });

  app.get("/ui/discover", async (req) => {
    const capability = (req.query as { capability?: string }).capability ?? "quote.request";
    return (await outbound.discover(capability)).map((a) => ({ agentId: a.agentId, orgName: a.orgName, orgDomain: a.orgDomain, name: a.card.name }));
  });

  app.post("/ui/outbound", async (req, reply) => {
    const body = req.body as OutboundRequest;
    if (!cfg.requests.includes(body?.capability)) {
      return reply.code(400).send({ error: "bad_request", message: `This node is not configured to request ${body?.capability}` });
    }
    try {
      return await outbound.start(body);
    } catch (e) {
      return reply.code(400).send({ error: "bad_request", message: (e as Error).message });
    }
  });

  app.get("/ui/disclosure", async () =>
    Promise.all(
      Object.keys(cfg.provides).map(async (capability) => ({
        capability,
        version: ctx.versionOf(capability),
        contractFields: await ctx.contracts.resultFields(capability, ctx.versionOf(capability)),
        allowed: ctx.disclosure.get(capability) ?? [],
      })),
    ),
  );

  app.put("/ui/disclosure/:capability", async (req, reply) => {
    const capability = (req.params as { capability: string }).capability;
    if (!cfg.provides[capability]) return reply.code(404).send({ error: "not_found", message: "Not a capability this node provides" });
    const contractFields = await ctx.contracts.resultFields(capability, ctx.versionOf(capability));
    const fields = ((req.body as { fields?: string[] })?.fields ?? []).filter((f) => contractFields.includes(f));
    ctx.disclosure.set(capability, fields);
    await repo.setSetting(disclosureKey(capability), fields);
    await new PgAuditSink(ctx.deps.db).write("disclosure.updated", { capability, fields });
    return { capability, allowed: fields };
  });

  app.get("/ui/connectors", async () =>
    Promise.all(Object.entries(ctx.connectors).map(async ([name, c]) => ({ name, kind: c.kind, ...(await c.health()) }))),
  );

  app.get("/ui/jobs", async () => ctx.jobs.stats());

  app.get("/ui/ai", async () => ({ ...ctx.ai.enabled, usage: await ctx.ai.usage() }));

  app.post("/ui/ai/reindex", async () => ({ indexed: await ctx.ai.reindex(ctx.connectors) }));

  /** Drafts a quote.request from a description. The operator reviews it; nothing is sent from here. */
  app.post("/ui/interpret", async (req, reply) => {
    const text = (req.body as { text?: string })?.text?.trim();
    if (!text) return reply.code(400).send({ error: "bad_request", message: "Describe what you need" });
    try {
      return await ctx.ai.interpret(text.slice(0, 2000));
    } catch (e) {
      return reply.code(422).send({ error: "interpretation_failed", message: (e as Error).message });
    }
  });

  app.get("/ui/audit", async (req) => repo.audit(Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500)));
}
