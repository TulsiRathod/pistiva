import { useState, type FormEvent } from "react";
import type { Agent, Api } from "../api.ts";
import { useAction, useAsync } from "../useAsync.ts";

export function Agents({ api, orgId }: { api: Api; orgId: string }) {
  const { data: agents, error, reload } = useAsync(() => api.agents(orgId), [api, orgId]);
  const [selected, setSelected] = useState<string | undefined>();
  const [form, setForm] = useState({ name: "", version: "0.1.0", endpointUrl: "" });
  const create = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await create.run(() => api.createAgent({ orgId, ...form }))) {
      setForm({ name: "", version: "0.1.0", endpointUrl: "" });
      reload();
    }
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Agents</h2>
        {error && <p className="error">{error}</p>}
        {agents?.length === 0 && <p className="muted">No agents yet.</p>}
        <ul className="list">
          {agents?.map((a) => (
            <li key={a.id} className={selected === a.id ? "selected" : ""} onClick={() => setSelected(a.id)}>
              <span>
                <strong>{a.name}</strong> <span className="muted">v{a.version}</span>
              </span>
              <span className={`badge ${a.status === "ACTIVE" ? "ok" : "bad"}`}>{a.status}</span>
            </li>
          ))}
        </ul>
        <form onSubmit={submit} className="stack">
          <h3>Register an agent</h3>
          <input required placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input required placeholder="Version" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
          <input required type="url" placeholder="Endpoint URL (your gateway)" value={form.endpointUrl}
            onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })} />
          {create.error && <p className="error">{create.error}</p>}
          <button disabled={create.busy}>Register agent</button>
        </form>
      </section>
      {selected && agents && (
        <AgentDetail api={api} agent={agents.find((a) => a.id === selected)!} onChanged={reload} />
      )}
    </div>
  );
}

function AgentDetail({ api, agent, onChanged }: { api: Api; agent: Agent; onChanged: () => void }) {
  const keys = useAsync(() => api.keys(agent.id), [api, agent.id]);
  const card = useAsync(() => api.card(agent.id).catch(() => undefined), [api, agent.id]);
  const [publicKey, setPublicKey] = useState("");
  const action = useAction();

  const suspended = agent.status === "SUSPENDED";

  return (
    <section className="card">
      <h2>{agent.name}</h2>
      <dl>
        <dt>Agent ID</dt>
        <dd>
          <code>{agent.id}</code>
        </dd>
        <dt>Endpoint</dt>
        <dd>
          <code>{agent.endpointUrl}</code>
        </dd>
      </dl>
      {action.error && <p className="error">{action.error}</p>}
      <button
        className={suspended ? "" : "danger"}
        disabled={action.busy}
        onClick={() => action.run(() => api.setAgentStatus(agent.id, suspended ? "ACTIVE" : "SUSPENDED")).then(onChanged)}
      >
        {suspended ? "Reactivate agent" : "Suspend agent (kill switch)"}
      </button>

      <h3>Public keys</h3>
      <p className="muted">Private keys never leave your gateway. Paste the base64url Ed25519 public key it generated.</p>
      <ul className="list">
        {keys.data?.map((k) => (
          <li key={k.kid}>
            <code title={k.publicKey}>{k.kid}</code>
            {k.revoked ? (
              <span className="badge bad">REVOKED</span>
            ) : (
              <button className="danger small" onClick={() => action.run(() => api.revokeKey(agent.id, k.kid)).then(keys.reload)}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          action.run(() => api.addKey(agent.id, publicKey.trim())).then((ok) => {
            if (ok) {
              setPublicKey("");
              keys.reload();
            }
          });
        }}
      >
        <input required placeholder="Public key" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} />
        <button disabled={action.busy}>Add key</button>
      </form>

      <h3>Signed agent card</h3>
      {card.data ? (
        <>
          <p className="muted">
            Signed with <code>{card.data.kid}</code> · published {new Date(card.data.publishedAt).toLocaleString()}
          </p>
          <pre>{JSON.stringify(JSON.parse(card.data.card), null, 2)}</pre>
        </>
      ) : (
        <p className="muted">Not published yet. The gateway publishes its card when it starts.</p>
      )}
    </section>
  );
}
