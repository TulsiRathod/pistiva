import { useState } from "react";
import type { Api } from "../api.ts";
import { useAsync } from "../useAsync.ts";

export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Per-task usage this organization earned as a provider and owes as a requester, by month. */
export function Usage({ api, orgId }: { api: Api; orgId: string }) {
  const [period, setPeriod] = useState(currentPeriod);
  const usage = useAsync(() => api.usage(orgId, period), [api, orgId, period]);
  const [csvError, setCsvError] = useState<string>();

  async function exportCsv() {
    try {
      const url = URL.createObjectURL(await api.download(`/orgs/${orgId}/usage.csv?period=${period}`));
      const a = document.createElement("a");
      a.href = url;
      a.download = `pistiva-usage-${period}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setCsvError((e as Error).message);
    }
  }

  const earned = usage.data?.totals.filter((t) => t.role === "provider") ?? [];
  const owed = usage.data?.totals.filter((t) => t.role === "requester") ?? [];

  return (
    <>
      <div className="row">
        <label className="row">
          <span className="muted">Month</span>
          <input type="month" value={period} max={currentPeriod()} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
        </label>
        <span className="spacer" />
        <button className="small" onClick={exportCsv} disabled={!usage.data?.records.length}>
          Export CSV
        </button>
      </div>
      {(usage.error || csvError) && <p className="error">{usage.error ?? csvError}</p>}
      <div className="stat-grid">
        <Totals label="Earned as provider" totals={earned} hint="Before the network fee; paid out monthly" />
        <Totals label="Owed as requester" totals={owed} hint="Completed tasks only; failed tasks are free" />
      </div>
      <section className="card">
        <h2>Completed tasks</h2>
        {usage.data?.records.length === 0 ? (
          <p className="muted">No priced tasks completed in {period}.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Completed</th>
                  <th>Role</th>
                  <th>Counterparty</th>
                  <th>Task type</th>
                  <th>Connection</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {usage.data?.records.map((r) => (
                  <tr key={r.taskId}>
                    <td className="muted">{new Date(r.completedAt).toLocaleString()}</td>
                    <td>
                      <span className={`chip ${r.role === "provider" ? "chip-green" : ""}`}>{r.role === "provider" ? "Earned" : "Owed"}</span>
                    </td>
                    <td>{r.counterpartyName}</td>
                    <td>
                      <code>{r.capability}</code>
                    </td>
                    <td className="muted">{r.connection}</td>
                    <td className="num">
                      {r.amount.toFixed(2)} {r.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Totals({ label, totals, hint }: { label: string; totals: { currency: string; tasks: number; amount: number }[]; hint: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{totals.length ? totals.map((t) => `${t.amount.toFixed(2)} ${t.currency}`).join(" · ") : "–"}</span>
      <span className="muted">{totals.length ? `${totals.reduce((n, t) => n + t.tasks, 0)} tasks · ${hint}` : hint}</span>
    </div>
  );
}
