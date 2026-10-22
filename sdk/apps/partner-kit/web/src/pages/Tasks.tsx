import { useEffect, useState, type FormEvent } from "react";
import type { Commitment, NodeApi, NodeInfo } from "../api.ts";
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
  const { task, messages, receipts, commitment } = detail.data;

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
      {task.direction === "outbound" && task.capability === "order.draft" && task.state === "completed" && (
        <CommitPanel api={api} taskId={task.id} commitment={commitment} onChange={detail.reload} />
      )}

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
              <th>Connection</th>
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
                <td title="Peer-to-peer is direct; through a TURN relay it is relayed. HTTPS counts as direct.">
                  {r.signed.receipt.connection === "relayed" ? <span className="badge warn">relayed</span> : <span className="badge ok">{r.signed.receipt.connection === "direct" ? "direct · p2p" : "direct · https"}</span>}
                </td>
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
  const [form, setForm] = useState({ sku: "", qty: "1", specs: "", budget: info.outbound.defaultBudget ?? "1000.00", currency: info.outbound.currency ?? "INR" });
  const ai = useAsync(() => api.ai(), [api]);
  const [description, setDescription] = useState("");
  const [drafted, setDrafted] = useState<{ missing: string[]; promptId: string } | undefined>();
  const drafting = useAction();
  async function draft() {
    await drafting.run(async () => {
      const out = await api.interpret(description);
      setForm({ ...form, sku: out.request.sku, qty: String(out.request.qty || ""), specs: out.request.specs ?? "" });
      setDrafted({ missing: out.missing, promptId: out.promptId });
    });
  }
  const [sent, setSent] = useState<string | undefined>();
  const action = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const r = await api.startOutbound({
        capability,
        request: { sku: form.sku.trim(), qty: Number(form.qty), ...(form.specs.trim() ? { specs: form.specs.trim() } : {}) },
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
      <p className="muted">Only the SKU, quantity and specs leave your node. The platform checks your budget and policy before any supplier sees the request.</p>
      {ai.data?.llm && (
        <div className="ai-draft">
          <label>
            Describe what you need <span className="muted">(drafted by {ai.data.llm}; you review before sending)</span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. forty thousand M8 hex nuts, zinc, by mid November" />
          </label>
          <div className="row">
            <button type="button" className="btn btn-outline" disabled={drafting.busy || !description.trim()} onClick={draft}>
              {drafting.busy ? "Drafting…" : "Fill the form from this"}
            </button>
            {drafted && (
              <span className="muted">
                Drafted with <code>{drafted.promptId}</code>
                {drafted.missing.length > 0 && <> · please fill in: {drafted.missing.join(", ")}</>}
              </span>
            )}
          </div>
          {drafting.error && <p className="error">{drafting.error}</p>}
        </div>
      )}
      <label>
        SKU
        <input required pattern="[A-Za-z0-9._-]+" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="BOLT-M8-50" />
      </label>
      <label>
        Specifications <span className="muted">(optional)</span>
        <input maxLength={2000} value={form.specs} onChange={(e) => setForm({ ...form, specs: e.target.value })} placeholder="A2 stainless, DIN 933" />
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


const COMMIT_LABELS: Record<Commitment["status"], [string, string]> = {
  confirming: ["Confirming with the supplier…", "warn"],
  awaiting_approval: ["Waiting for an approver in your organization", "warn"],
  confirmed: ["Order confirmed", "ok"],
  approval_rejected: ["Approval rejected", "bad"],
  changes_requested: ["Approver requested changes", "bad"],
  refused: ["Supplier refused the confirmation", "bad"],
  failed: ["Confirmation failed", "bad"],
};

/** Turn a held draft into a confirmed order; above the threshold it waits for a human approver. */
function CommitPanel({ api, taskId, commitment, onChange }: { api: NodeApi; taskId: string; commitment: Commitment | null; onChange: () => void }) {
  const action = useAction();
  const canCommit = !commitment || commitment.status === "failed" || commitment.status === "refused";
  const [label, cls] = commitment ? COMMIT_LABELS[commitment.status] : ["Draft held by the supplier — not yet committed", "warn"];
  return (
    <div className={`commit-panel ${cls}`}>
      <div>
        <strong>{label}</strong>
        {commitment && (
          <span className="muted">
            {" "}
            · {commitment.orderRef} · {commitment.amount} {commitment.currency}
          </span>
        )}
        {commitment?.note && <p className="muted commit-note">{commitment.note}</p>}
        {commitment?.status === "awaiting_approval" && (
          <p className="muted commit-note">An owner, admin or approver can decide it under Approvals in the Pistiva console. This node confirms automatically once approved.</p>
        )}
      </div>
      {canCommit && (
        <button className="btn btn-dark" disabled={action.busy} onClick={() => action.run(() => api.commit(taskId)).then(onChange)}>
          {commitment ? "Try again" : "Commit order"}
        </button>
      )}
      {action.error && <p className="error">{action.error}</p>}
    </div>
  );
}