import { kidFor, loadKeyFile, PlatformClient } from "@pistiva/agent-sdk";
import { envFromProcess, loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { createKit } from "./kit.ts";
import { startTracing } from "./tracing.ts";

const env = envFromProcess();
const cfg = await loadConfig(env.configPath);
const tracing = startTracing(`pistiva-node ${cfg.agent.name}`);
const keys = await loadKeyFile(env.keyFile, env.keyPassphrase);
const kid = kidFor(keys.publicKey);
const platform = new PlatformClient({ baseUrl: env.platformUrl, agentId: env.agentId, kid, keys, statusTtlMs: 5_000 });
const db = createPool(env.databaseUrl);

const kit = await createKit({
  cfg,
  db,
  platform,
  keys,
  agentId: env.agentId,
  orgId: env.orgId,
  kid,
  publicUrl: env.publicUrl,
  adminPassword: env.adminPassword,
  sessionSecret: env.sessionSecret,
  metricsToken: process.env.KIT_METRICS_TOKEN,
  logger: process.env.LOG_REQUESTS === "1",
});
await kit.app.listen({ port: env.port, host: env.host });
console.log(`Pistiva node "${cfg.agent.name}" listening on :${env.port} (public ${env.publicUrl})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await kit.close();
    await db.end();
    await tracing?.shutdown();
    process.exit(0);
  });
}
