import type { Api } from "../api.ts";
import { useAction, useAsync } from "../useAsync.ts";

export function Overview({ api, orgId }: { api: Api; orgId: string }) {
  const { data: org, error, reload } = useAsync(() => api.org(orgId), [api, orgId]);
  const stats = useAsync(
    () => Promise.all([api.agents(orgId), api.audit(orgId)]).then(([agents, events]) => ({ agents, events })),
    [api, orgId],
  );
  const verify = useAction();

  if (error) return <p className="error">{error}</p>;
  if (!org) return <p className="muted">Loading…</p>;

  const agents = stats.data?.agents ?? [];
  const events = stats.data?.events ?? [];
  const tiles: [string, string | number, string][] = [
    ["Agents", agents.length, `${agents.filter((a) => a.status === "ACTIVE").length} active`],
    ["Signed rounds", events.filter((e) => e.type === "RECEIPT_RECORDED").length, "receipts in the last 100 events"],
    ["Grants issued", events.filter((e) => e.type === "GRANT_ISSUED").length, "task grants from policy"],
    ["Denied by policy", events.filter((e) => e.type === "GRANT_DENIED").length, "blocked before any message was sent"],
  ];

  return (
    <>
      <div className="stat-grid">
        {tiles.map(([label, value, hint]) => (
          <div key={label} className="stat">
            <span className="stat-label">{label}</span>
            <span className="stat-value">{stats.data ? value : "–"}</span>
            <span className="muted">{hint}</span>
          </div>
        ))}
      </div>

      <section className="card">
        <h2>{org.name}</h2>
        <dl>
          <dt>Domain</dt>
          <dd>{org.domain}</dd>
          <dt>Verification</dt>
          <dd>
            <span className={`badge ${org.verificationStatus === "VERIFIED" ? "ok" : "warn"}`}>{org.verificationStatus}</span>
          </dd>
          <dt>Status</dt>
          <dd>
            <span className={`badge ${org.status === "ACTIVE" ? "ok" : "bad"}`}>{org.status}</span>
          </dd>
          <dt>Organization ID</dt>
          <dd>
            <code>{org.id}</code>
          </dd>
        </dl>
        {org.verificationStatus !== "VERIFIED" && (
          <div className="callout">
            <p>
              Your agents are not listed in discovery and cannot request tasks until the organization is verified. Publish this DNS
              record, then check it:
            </p>
            <pre>{org.verificationRecord}</pre>
            {verify.error && <p className="error">{verify.error}</p>}
            <button disabled={verify.busy} onClick={() => verify.run(() => api.verifyOrg(orgId, "dns")).then((ok) => ok && reload())}>
              Check DNS record
            </button>
          </div>
        )}
      </section>
    </>
  );
}
