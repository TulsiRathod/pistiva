import { useState, type FormEvent } from "react";
import type { Api, Role, Webhook } from "../api.ts";
import { useAction, useAsync } from "../useAsync.ts";

/** Signed HTTPS callbacks for events that concern the organization. The secret is shown once, at creation. */
export function Webhooks({ api, orgId, role }: { api: Api; orgId: string; role: Role }) {
  const hooks = useAsync(() => api.webhooks(orgId), [api, orgId]);
  const types = useAsync(() => api.webhookEventTypes(), [api]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["*"]);
  const [created, setCreated] = useState<Webhook | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const remove = useAction();
  const canManage = role === "OWNER" || role === "ADMIN";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(undefined);
    try {
      setCreated(await api.createWebhook(orgId, { url: url.trim(), events }));
      setUrl("");
      hooks.reload();
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const toggle = (type: string) =>
    setEvents((cur) => (cur.includes(type) ? cur.filter((t) => t !== type) : [...cur.filter((t) => (type === "*" ? false : t !== "*")), type]));

  return (
    <div className="grid">
      <section className="card">
        <h2>Webhooks</h2>
        <p className="muted">
          Each delivery is a POST signed with <code>X-Pistiva-Signature: sha256=HMAC(secret, timestamp + "." + body)</code>. Failed deliveries retry with backoff for up to 10 attempts.
          Deduplicate on <code>X-Pistiva-Delivery</code>.
        </p>
        {hooks.error && <p className="error">{hooks.error}</p>}
        {hooks.data?.length === 0 && <p className="muted">No webhooks yet.</p>}
        <ul className="list">
          {hooks.data?.map((h) => (
            <li key={h.id} className={open === h.id ? "selected" : ""} onClick={() => setOpen(open === h.id ? undefined : h.id)}>
              <span>
                <code>{h.url}</code>
                <div className="muted">{h.events.join(", ")}</div>
              </span>
              {canManage && (
                <button
                  className="danger small"
                  disabled={remove.busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm("Delete this webhook? Pending deliveries are dropped.")) remove.run(() => api.deleteWebhook(orgId, h.id)).then(hooks.reload);
                  }}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
        {remove.error && <p className="error">{remove.error}</p>}
        {open && <Deliveries api={api} orgId={orgId} webhookId={open} />}
      </section>

      {canManage ? (
        <section className="card">
          <form onSubmit={submit} className="stack">
            <h3>Add a webhook</h3>
            <input required type="url" placeholder="https://example.com/pistiva-events" value={url} onChange={(e) => setUrl(e.target.value)} />
            <fieldset className="events">
              <legend className="muted">Events</legend>
              {(types.data ?? ["*"]).map((t) => (
                <label key={t} className="row">
                  <input type="checkbox" checked={events.includes(t)} onChange={() => toggle(t)} /> <code>{t === "*" ? "* (all events)" : t}</code>
                </label>
              ))}
            </fieldset>
            {createError && <p className="error">{createError}</p>}
            <button disabled={creating || events.length === 0}>Create webhook</button>
          </form>
          {created?.secret && (
            <div className="notice">
              <strong>Signing secret — copy it now, it won't be shown again:</strong>
              <pre>{created.secret}</pre>
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          <p className="muted">Only owners and admins can add or delete webhooks.</p>
        </section>
      )}
    </div>
  );
}

function Deliveries({ api, orgId, webhookId }: { api: Api; orgId: string; webhookId: string }) {
  const deliveries = useAsync(() => api.webhookDeliveries(orgId, webhookId), [api, orgId, webhookId]);
  return (
    <>
      <div className="row">
        <h3>Recent deliveries</h3>
        <span className="spacer" />
        <button className="link" onClick={deliveries.reload}>
          Refresh
        </button>
      </div>
      {deliveries.error && <p className="error">{deliveries.error}</p>}
      {deliveries.data?.length === 0 && <p className="muted">Nothing has been sent to this endpoint yet.</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Status</th>
              <th className="num">Attempts</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.data?.map((d) => (
              <tr key={d.id}>
                <td>
                  <code>{d.eventType}</code>
                  <div className="muted">{new Date(d.createdAt).toLocaleString()}</div>
                </td>
                <td>
                  {d.deliveredAt ? <span className="badge ok">DELIVERED</span> : d.attempts >= 10 ? <span className="badge bad">GAVE UP</span> : <span className="badge warn">RETRYING</span>}
                </td>
                <td className="num">{d.attempts}</td>
                <td className="muted">{d.lastError ?? (d.lastStatus ? `HTTP ${d.lastStatus}` : "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
