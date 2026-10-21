import { useState } from "react";
import type { Api, Approval, Role } from "../api.ts";
import { useAction, useAsync } from "../useAsync.ts";

const DECIDERS: Role[] = ["OWNER", "ADMIN", "APPROVER"];

function relative(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
}

function summaryOf(a: Approval): Record<string, unknown> {
  try {
    return a.summary ? (JSON.parse(a.summary) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Commitments your agents want to make that policy says a person must approve. The platform will
 * not issue the commitment grant until one of the organization's approvers decides here.
 */
export function Approvals({ api, orgId, role }: { api: Api; orgId: string; role: Role }) {
  const all = useAsync(() => api.approvals(orgId), [api, orgId]);
  const canDecide = DECIDERS.includes(role);
  const pending = (all.data ?? []).filter((a) => a.status === "PENDING");
  const decided = (all.data ?? []).filter((a) => a.status !== "PENDING");

  return (
    <>
      {all.error && <p className="error">{all.error}</p>}
      {!canDecide && <p className="callout">Your role ({role.toLowerCase()}) can see approvals but not decide them. Owners, admins and approvers can.</p>}
      {all.data && pending.length === 0 && (
        <section className="card empty">
          <h3>Nothing to approve</h3>
          <p className="muted">When one of your agents wants to commit above your approval threshold, the request appears here.</p>
        </section>
      )}
      {pending.map((a) => (
        <PendingApproval key={a.id} api={api} a={a} canDecide={canDecide} onDecided={all.reload} />
      ))}

      <section className="card">
        <h2>Decided</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th className="num">Amount</th>
                <th>Decision</th>
                <th>Comment</th>
                <th>Used</th>
                <th>Decided</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td>
                    <code>{a.reference}</code>
                    <div className="muted">{String(summaryOf(a).supplier ?? a.capability)}</div>
                  </td>
                  <td className="num">
                    {a.amount} {a.currency}
                  </td>
                  <td>
                    <span className={`badge ${a.status === "APPROVED" ? "ok" : "bad"}`}>{a.status.replace("_", " ")}</span>
                  </td>
                  <td className="muted">{a.comment ?? "—"}</td>
                  <td>{a.used ? <span className="badge ok">order placed</span> : <span className="muted">—</span>}</td>
                  <td className="muted">{a.decidedAt ? relative(a.decidedAt) : "—"}</td>
                </tr>
              ))}
              {decided.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No decisions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function PendingApproval({ api, a, canDecide, onDecided }: { api: Api; a: Approval; canDecide: boolean; onDecided: () => void }) {
  const [comment, setComment] = useState("");
  const action = useAction();
  const summary = summaryOf(a);
  const decide = (d: "APPROVED" | "REJECTED" | "CHANGES_REQUESTED") =>
    action.run(() => api.decideApproval(a.id, d, comment.trim() || undefined)).then((ok) => ok && onDecided());

  return (
    <section className="card approval">
      <div className="row">
        <span className="chip chip-warn">needs approval</span>
        <span className="muted">
          <code>{a.capability}</code> · requested {relative(a.requestedAt)}
        </span>
      </div>
      <div className="approval-body">
        <div>
          <span className="stat-label">Commit</span>
          <span className="approval-amount">
            {a.amount} <span className="muted">{a.currency}</span>
          </span>
        </div>
        <dl>
          <dt>Order</dt>
          <dd>
            <code>{a.reference}</code>
          </dd>
          <dt>Supplier</dt>
          <dd>{String(summary.supplier ?? `agent ${a.providerAgentId.slice(0, 8)}`)}</dd>
          <dt>Requested by</dt>
          <dd>
            agent <code>{a.requesterAgentId.slice(0, 8)}</code>
          </dd>
        </dl>
      </div>
      {canDecide && (
        <>
          <label>
            Comment <span className="muted">(required to reject or request changes)</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. Within the Q4 maintenance budget" />
          </label>
          {action.error && <p className="error">{action.error}</p>}
          <div className="row">
            <button disabled={action.busy} onClick={() => decide("APPROVED")}>
              Approve
            </button>
            <button className="btn btn-outline" disabled={action.busy || !comment.trim()} onClick={() => decide("CHANGES_REQUESTED")}>
              Request changes
            </button>
            <button className="danger" disabled={action.busy || !comment.trim()} onClick={() => decide("REJECTED")}>
              Reject
            </button>
          </div>
        </>
      )}
    </section>
  );
}
