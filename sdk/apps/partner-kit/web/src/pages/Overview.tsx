import type { NodeApi, NodeInfo } from "../api.ts";
import { relative, StateBadge, type Tab } from "../App.tsx";
import { useAsync } from "../useAsync.ts";

export function Overview({ api, info, go }: { api: NodeApi; info: NodeInfo; go: (t: Tab) => void }) {
  const recent = useAsync(() => api.tasks(), [api, info.counts.inbound, info.counts.outbound]);
  const connectors = useAsync(() => api.connectors(), [api]);
  const tiles: [string, number, string, Tab][] = [
    ["Requests received", info.counts.inbound, "answered from your own systems", "inbox"],
    ["Requests sent", info.counts.outbound, "to suppliers' agents", "outbox"],
    ["Waiting for you", info.counts.openQuestions, "clarifying questions to answer", "questions"],
    ["Signed rounds", info.counts.receipts, "receipts held on this node", "activity"],
  ];

  return (
    <>
      <div className="stat-grid">
        {tiles.map(([label, value, hint, tab]) => (
          <button key={label} className="stat stat-link" onClick={() => go(tab)}>
            <span className="stat-label">{label}</span>
            <span className="stat-value">{value}</span>
            <span className="muted">{hint}</span>
          </button>
        ))}
      </div>

      <div className="admin-grid">
        <section className="card">
          <h2>Recent tasks</h2>
          {recent.data?.length === 0 && <p className="muted">No tasks yet. Start one from the Outbox, or wait for a request.</p>}
          <ul className="feed">
            {recent.data?.slice(0, 8).map((t) => (
              <li key={t.id}>
                <span className={`chip ${t.direction === "inbound" ? "chip-green" : ""}`}>{t.direction === "inbound" ? "Received" : "Sent"}</span>
                <span className="feed-main">
                  <code>{t.capability}</code> · {t.peerName ?? t.peerAgentId.slice(0, 8)}
                  {t.summary && <span className="muted"> · {t.summary}</span>}
                </span>
                <span className="feed-time">
                  <StateBadge state={t.state} /> <span className="muted">{relative(t.updatedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>This node</h2>
          <dl>
            <dt>Answers</dt>
            <dd>{info.provides.length ? info.provides.map((p) => <code key={p} className="tag">{p}</code>) : <span className="muted">nothing</span>}</dd>
            <dt>Can request</dt>
            <dd>{info.requests.length ? info.requests.map((p) => <code key={p} className="tag">{p}</code>) : <span className="muted">nothing</span>}</dd>
            <dt>Endpoint</dt>
            <dd>
              <code>{info.agent.publicUrl}</code>
            </dd>
          </dl>
          <h3>Data sources</h3>
          <ul className="list">
            {connectors.data?.map((c) => (
              <li key={c.name}>
                <span>
                  <strong>{c.name}</strong> <span className="muted">{c.kind}</span>
                </span>
                <span className={`badge ${c.ok ? "ok" : "bad"}`}>{c.ok ? (c.items !== undefined ? `${c.items} items` : "ok") : "unreachable"}</span>
              </li>
            ))}
            {connectors.data?.length === 0 && <li className="muted">No connectors configured.</li>}
          </ul>
        </section>
      </div>
    </>
  );
}
