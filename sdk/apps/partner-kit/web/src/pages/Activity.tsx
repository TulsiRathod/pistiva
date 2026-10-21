import type { NodeApi } from "../api.ts";
import { relative } from "../App.tsx";
import { useAsync } from "../useAsync.ts";

function describe(details: Record<string, unknown>): string {
  const parts = [details.capability, details.taskId && `task ${String(details.taskId).slice(0, 8)}`, details.round && `round ${details.round}`, details.code, details.message ?? details.error];
  return parts.filter(Boolean).join(" · ");
}

export function Activity({ api }: { api: NodeApi }) {
  const log = useAsync(() => api.audit(200), [api]);
  return (
    <section className="card">
      <div className="row">
        <h2>Node log</h2>
        <span className="spacer" />
        <button className="link" onClick={log.reload}>
          Refresh
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {log.data?.map((e) => (
              <tr key={e.id} className={e.event.includes("rejected") || e.event.includes("invalid") ? "denied" : ""}>
                <td className="muted" title={new Date(e.createdAt).toLocaleString()}>{relative(e.createdAt)}</td>
                <td><code>{e.event}</code></td>
                <td title={JSON.stringify(e.details)}>{describe(e.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
