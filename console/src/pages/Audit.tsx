import { useState } from "react";
import type { Api } from "../api.ts";
import { useAsync } from "../useAsync.ts";

function summarize(details: string | null): string {
  if (!details) return "";
  try {
    const d = JSON.parse(details) as Record<string, unknown>;
    return String(d.reason ?? d.status ?? d.capability ?? d.method ?? "");
  } catch {
    return "";
  }
}

export function Audit({ api, orgId }: { api: Api; orgId: string }) {
  const [taskId, setTaskId] = useState("");
  const [filter, setFilter] = useState<string | undefined>();
  const { data, error, loading, reload } = useAsync(() => api.audit(orgId, filter), [api, orgId, filter]);

  return (
    <section className="card">
      <div className="row">
        <h2>Audit log</h2>
        <span className="spacer" />
        <input placeholder="Filter by task ID" value={taskId} onChange={(e) => setTaskId(e.target.value)} />
        <button onClick={() => setFilter(taskId.trim() || undefined)}>Filter</button>
        <button className="link" onClick={reload}>
          Refresh
        </button>
      </div>
      <p className="muted">Metadata only: task payloads never reach the platform. Receipts show hashes signed by both parties.</p>
      {error && <p className="error">{error}</p>}
      {loading && !data && <p className="muted">Loading…</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Task</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((e) => (
              <tr key={e.id} className={e.type === "GRANT_DENIED" ? "denied" : ""}>
                <td>{new Date(e.createdAt).toLocaleString()}</td>
                <td>
                  <code>{e.type}</code>
                </td>
                <td>
                  <code>{e.actor}</code>
                </td>
                <td>
                  {e.taskId && (
                    <button className="link" onClick={() => { setTaskId(e.taskId!); setFilter(e.taskId!); }}>
                      <code>{e.taskId.slice(0, 8)}</code>
                    </button>
                  )}
                </td>
                <td title={e.details ?? ""}>
                  {summarize(e.details)}
                  {e.responseHash && <code className="muted"> {e.responseHash.slice(0, 18)}…</code>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
