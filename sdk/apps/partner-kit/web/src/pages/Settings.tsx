import { useEffect, useState } from "react";
import type { Disclosure, NodeApi } from "../api.ts";
import { useAction, useAsync } from "../useAsync.ts";

export function Settings({ api }: { api: NodeApi }) {
  const disclosure = useAsync(() => api.disclosure(), [api]);
  const connectors = useAsync(() => api.connectors(), [api]);

  return (
    <>
      <section className="card">
        <h2>What you disclose</h2>
        <p className="muted">
          For each request type you answer, choose which result fields may leave your systems. You can only narrow what the published contract
          allows; the requester's grant may narrow it further.
        </p>
        {disclosure.data?.length === 0 && <p className="muted">This node doesn't answer any request types.</p>}
        {disclosure.data?.map((d) => <DisclosureEditor key={d.capability} api={api} d={d} onSaved={disclosure.reload} />)}
      </section>

      <section className="card">
        <div className="row">
          <h2>Data sources</h2>
          <span className="spacer" />
          <button className="link" onClick={connectors.reload}>
            Check again
          </button>
        </div>
        <p className="muted">Connectors read your own systems locally. Configure them in config/agents.yaml.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {connectors.data?.map((c) => (
                <tr key={c.name}>
                  <td><strong>{c.name}</strong></td>
                  <td><code>{c.kind}</code></td>
                  <td><span className={`badge ${c.ok ? "ok" : "bad"}`}>{c.ok ? "reachable" : "unreachable"}</span></td>
                  <td className="muted">{c.items !== undefined ? `${c.items} items` : c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function DisclosureEditor({ api, d, onSaved }: { api: NodeApi; d: Disclosure; onSaved: () => void }) {
  const [fields, setFields] = useState<string[]>(d.allowed);
  const action = useAction();
  useEffect(() => setFields(d.allowed), [d.allowed]);
  const dirty = fields.slice().sort().join() !== d.allowed.slice().sort().join();

  return (
    <div className="disclosure">
      <div className="row">
        <h3>
          <code>{d.capability}@{d.version}</code>
        </h3>
        <span className="muted">
          {fields.length} of {d.contractFields.length} fields shared
        </span>
      </div>
      <div className="field-grid">
        {d.contractFields.map((f) => (
          <label key={f} className={`check field ${fields.includes(f) ? "on" : ""}`}>
            <input type="checkbox" checked={fields.includes(f)} onChange={(e) => setFields(e.target.checked ? [...fields, f] : fields.filter((x) => x !== f))} />
            <code>{f}</code>
          </label>
        ))}
      </div>
      {action.error && <p className="error">{action.error}</p>}
      <div className="row">
        <button className="small" disabled={!dirty || action.busy} onClick={() => action.run(() => api.setDisclosure(d.capability, fields)).then((ok) => ok && onSaved())}>
          Save
        </button>
        {dirty && <span className="muted">Applies to the next request you answer.</span>}
      </div>
    </div>
  );
}
