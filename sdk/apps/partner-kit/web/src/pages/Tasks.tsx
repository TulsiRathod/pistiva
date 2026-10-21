import { useEffect, useState, type FormEvent } from "react";
import type { NodeApi, NodeInfo } from "../api.ts";
import { relative, StateBadge } from "../App.tsx";
import { useAction, useAsync } from "../useAsync.ts";

export function Tasks({ api, direction, info }: { api: NodeApi; direction: "inbound" | "outbound"; info: NodeInfo }) {
  const tasks = useAsync(() => api.tasks(direction), [api, direction]);
  const [selected, setSelected] = useState<string | undefined>();
  const [composing, setComposing] = useState(false);

  // Outbound tasks progress in the background; keep the list fresh while the page is open.
  useEffect(() => {
    const t = setInterval(tasks.reload, 3000);
    return () => clearInterval(t);
  }, [tasks.reload]);

  return (
    <div className="grid">
      <section className="card">
        <div className="row">
          <h2>{direction === "inbound" ? "Received" : "Sent"}</h2>
          <span className="muted">{tasks.data?.length ?? 0}</span>
          <span className="spacer" />
          {direction === "outbound" && info.requests.length > 0 && (
            <button className="small" onClick={() => setComposing(true)}>
              New request
            </button>
          )}
        </div>
        {tasks.error && <p className="error">{tasks.error}</p>}
        {tasks.data?.length === 0 && <p className="muted">Nothing here yet.</p>}
        <ul className="list">
          {tasks.data?.map((t) => (
            <li key={t.id} className={selected === t.id ? "selected" : ""} onClick={() => { setSelected(t.id); setComposing(false); }}>
              <span className="task-line">
                <strong>{t.peerName ?? t.peerAgentId.slice(0, 8)}</strong>
                <span className="muted">
                  <code>{t.capability}</code> · {t.summary ?? t.error ?? "…"}
                </span>
              </span>
              <span className="task-meta">
                <StateBadge state={t.state} />
                <span className="muted">{relative(t.updatedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {composing ? (
        <NewRequest api={api} info={info} onDone={() => { setComposing(false); tasks.reload(); }} />
      ) : selected ? (
        <TaskDetail api={api} id={selected} />
      ) : (
        <section className="card empty">
          <h3>Select a task</h3>
          <p className="muted">See every message exchanged, what was withheld, and the signed receipts for each round.</p>
        </section>
      )}
    </div>
  );
}

function TaskDetail({ api, id }: { api: NodeApi; id: string }) {
  const detail = useAsync(() => api.task(id), [api, id]);
  useEffect(() => {
    const t = setInterval(detail.reload, 3000);
    return () => clearInterval(t);
  }, [detail.reload]);
  if (detail.error) return <section className="card"><p className="error">{detail.error}</p></section>;
  if (!detail.data) return <section className="card"><p className="muted">Loading…</p></section>;
  const { task, messages, receipts } = detail.data;

  return (
    <section className="card">
      <div className="row">
        <h2>{task.peerName ?? task.peerAgentId.slice(0, 8)}</h2>
        <StateBadge state={task.state} />
        {task.approvalRequired && <span className="chip chip-warn">needs approval to commit</span>}
      </div>
      <p className="muted">
        <code>{task.capability}@{task.taskTypeVersion}</code> · task <code>{task.id.slice(0, 8)}</code>
        {task.budget && ` · budget ${task.budget} ${task.currency}`}
      </p>
      {task.error && <p className="error">{task.error}</p>}

      <div className="thread">
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.sender === "us" ? "out" : "in"}`}>
            <span className="bubble-head">
              {m.sender === "us" ? "You" : "Them"} · {m.kind} · round {m.round}
            </span>
            {m.data && <pre>{JSON.stringify(m.data, null, 2)}</pre>}
            {m.withheld && m.withheld.length > 0 && (
              <span className="withheld">
                Withheld: {m.withheld.map((f) => <code key={f}>{f}</code>)}
              </span>
            )}
            {m.state && <span className={`state ${m.state === "completed" ? "done" : ""}`}>{m.state}</span>}
          </div>
        ))}
        {messages.length === 0 && <p className="muted">No messages yet.</p>}
      </div>

      <h3>Receipts</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Round</th>
              <th>State</th>
              <th>Request hash</th>
              <th>Response hash</th>
              <th>Signatures</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => (
              <tr key={r.round}>
                <td>{r.round}</td>
                <td>{r.state}</td>
                <td><code title={String(r.signed.receipt.requestHash)}>{String(r.signed.receipt.requestHash).slice(0, 18)}…</code></td>
                <td><code title={String(r.signed.receipt.responseHash)}>{String(r.signed.receipt.responseHash).slice(0, 18)}…</code></td>
                <td>
                  <span className="badge ok">provider</span>{" "}
                  <span className={`badge ${r.countersigned ? "ok" : "warn"}`}>{r.countersigned ? "requester" : "awaiting countersign"}</span>
                  {r.recorded && <> <span className="badge ok">on platform</span></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NewRequest({ api, info, onDone }: { api: NodeApi; info: NodeInfo; onDone: () => void }) {
  const [capability] = useState(info.requests.includes("quote.request") ? "quote.request" : info.requests[0]!);
  const suppliers = useAsync(() => api.discover(capability), [api, capability]);
  const [picked, setPicked] = useState<string[]>([]);
  const [form, setForm] = useState({ sku: "", qty: "1", budget: info.outbound.defaultBudget ?? "1000.00", currency: info.outbound.currency ?? "INR" });
  const [sent, setSent] = useState<string | undefined>();
  const action = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const r = await api.startOutbound({
        capability,
        request: { sku: form.sku.trim(), qty: Number(form.qty) },
        budget: form.budget,
        currency: form.currency,
        providerAgentIds: picked,
      });
      setSent(`Sent to ${r.providers.map((p) => p.orgName).join(", ") || "no suppliers"}`);
      setTimeout(onDone, 1200);
    });
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>New quote request</h2>
      <p className="muted">Only the SKU and quantity leave your node. The platform checks your budget and policy before any supplier sees the request.</p>
      <label>
        SKU
        <input required pattern="[A-Za-z0-9._-]+" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="BOLT-M8-50" />
      </label>
      <div className="row">
        <label className="grow">
          Quantity
          <input required type="number" min={1} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
        </label>
        <label className="grow">
          Budget per supplier
          <input required pattern="\d+(\.\d{1,2})?" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
        </label>
        <label>
          Currency
          <input required maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
        </label>
      </div>
      <fieldset className="suppliers">
        <legend>Suppliers (none selected = all verified suppliers)</legend>
        {suppliers.error && <p className="error">{suppliers.error}</p>}
        {suppliers.data?.length === 0 && <p className="muted">No verified suppliers offer {capability} yet.</p>}
        {suppliers.data?.map((s) => (
          <label key={s.agentId} className="check">
            <input
              type="checkbox"
              checked={picked.includes(s.agentId)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, s.agentId] : picked.filter((p) => p !== s.agentId))}
            />
            <span>
              <strong>{s.orgName}</strong> <span className="muted">{s.orgDomain}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {action.error && <p className="error">{action.error}</p>}
      {sent && <p className="success">{sent}</p>}
      <div className="row">
        <button className="btn btn-dark" disabled={action.busy}>
          Send request <span aria-hidden>→</span>
        </button>
        <button type="button" className="link" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

