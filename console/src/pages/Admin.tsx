import { useMemo, useState } from "react";
import type { AdminEvent, AdminOrg, Api, Certification, DayActivity } from "../api.ts";
import { useAction, useAsync } from "../useAsync.ts";
import { CertBadge } from "./Agents.tsx";

/** Platform-admin dashboard: network health, activity, verification queue and organization management. */
export function Admin({ api }: { api: Api }) {
  const [days, setDays] = useState(14);
  const overview = useAsync(() => api.adminOverview(days), [api, days]);
  const orgs = useAsync(() => api.adminOrgs(), [api]);
  const events = useAsync(() => api.adminEvents(12), [api]);
  const certs = useAsync(() => api.adminCertifications(), [api]);
  const action = useAction();

  const refresh = () => {
    overview.reload();
    orgs.reload();
    events.reload();
    certs.reload();
  };
  const act = (fn: () => Promise<unknown>) => action.run(fn).then((ok) => ok && refresh());

  const o = overview.data;
  const pending = (orgs.data ?? []).filter((x) => x.verificationStatus === "PENDING" && x.status === "ACTIVE");
  const blockedRate = o && o.grantsIssued + o.grantsDenied > 0 ? Math.round((o.grantsDenied / (o.grantsIssued + o.grantsDenied)) * 100) : 0;

  return (
    <>
      {(overview.error || orgs.error || action.error) && <p className="error">{overview.error ?? orgs.error ?? action.error}</p>}

      <div className="stat-grid">
        <Stat label="Organizations" value={o?.organizations.total} hint={o && `${o.organizations.verified} verified · ${o.organizations.pending} pending`} />
        <Stat label="Agents" value={o?.agents.total} hint={o && `${o.agents.active} active · ${o.agents.liveKeys} live keys`} />
        <Stat label="Signed rounds" value={o?.receipts} hint="receipts countersigned by both parties" />
        <Stat label="Blocked by policy" value={o ? `${blockedRate}%` : undefined} hint={o && `${o.grantsDenied} of ${o.grantsIssued + o.grantsDenied} grant requests`} />
      </div>

      <div className="admin-grid">
        <section className="card">
          <div className="row">
            <h2>Network activity</h2>
            <span className="spacer" />
            <div className="segmented" role="group" aria-label="Time range">
              {[7, 14, 30].map((d) => (
                <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>
                  {d}d
                </button>
              ))}
            </div>
          </div>
          {o ? <ActivityChart data={o.activity} /> : <p className="muted">Loading…</p>}
        </section>

        <section className="card">
          <div className="row">
            <h2>Verification queue</h2>
            <span className="chip chip-warn">{pending.length} pending</span>
          </div>
          {pending.length === 0 ? (
            <p className="muted">No organizations are waiting for verification.</p>
          ) : (
            <ul className="queue">
              {pending.slice(0, 6).map((p) => (
                <li key={p.id}>
                  <span className="avatar">{p.name[0]?.toUpperCase()}</span>
                  <div className="who">
                    <strong>{p.name}</strong>
                    <span className="muted">
                      {p.domain} · {relative(p.createdAt)}
                    </span>
                  </div>
                  <button className="small" disabled={action.busy} onClick={() => act(() => api.verifyOrg(p.id, "manual"))}>
                    Verify
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="muted queue-note">Manual verification is for pilots. Organizations can self-verify with a DNS TXT record.</p>
        </section>
      </div>

      <section className="card">
        <div className="row">
          <h2>Recent activity</h2>
          <span className="spacer" />
          <button className="link" onClick={refresh}>
            Refresh
          </button>
        </div>
        <EventFeed events={events.data ?? []} />
      </section>

      <CertificationTable certs={certs.data ?? []} orgs={orgs.data ?? []} busy={action.busy} act={act} api={api} />

      <OrgTable orgs={orgs.data ?? []} busy={action.busy} act={act} api={api} />
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string | undefined; hint?: string | false }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value ?? "–"}</span>
      <span className="muted">{hint || " "}</span>
    </div>
  );
}

const SERIES: { key: keyof Omit<DayActivity, "date">; label: string; color: string }[] = [
  { key: "grantsIssued", label: "Grants issued", color: "var(--series-1)" },
  { key: "grantsDenied", label: "Denied by policy", color: "var(--series-2)" },
  { key: "receipts", label: "Signed rounds", color: "var(--series-3)" },
];

/** Stacked daily columns. Legend always shown; a table view is the relief for the low-contrast slot. */
function ActivityChart({ data }: { data: DayActivity[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const W = 640;
  const H = 220;
  const pad = { top: 12, right: 8, bottom: 26, left: 32 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const totals = data.map((d) => d.grantsIssued + d.grantsDenied + d.receipts);
  const max = niceMax(Math.max(1, ...totals));
  const ticks = [0, max / 2, max];
  const slot = innerW / data.length;
  const barW = Math.max(6, Math.min(28, slot * 0.6));
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const labelEvery = data.length > 14 ? 5 : data.length > 7 ? 2 : 1;

  return (
    <div className="viz">
      <div className="viz-head">
        <ul className="legend">
          {SERIES.map((s) => (
            <li key={s.key}>
              <span className="swatch" style={{ background: s.color }} /> {s.label}
            </li>
          ))}
        </ul>
        <button className="link" onClick={() => setAsTable(!asTable)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {asTable ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day (UTC)</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="num">
                      {d[s.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-wrap">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily network activity for the last ${data.length} days`} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
                <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="tick">
                  {t}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = pad.left + slot * i + slot / 2;
              let acc = 0;
              const segs = SERIES.map((s) => ({ s, v: d[s.key] })).filter((x) => x.v > 0);
              return (
                <g key={d.date}>
                  {segs.map(({ s, v }, j) => {
                    const top = y(acc + v);
                    const bottom = y(acc);
                    acc += v;
                    // 2px surface gap between stacked segments; rounded data-end only on the top segment.
                    const h = Math.max(1, bottom - top - (j > 0 ? 2 : 0));
                    const isTop = j === segs.length - 1;
                    return (
                      <path
                        key={s.key}
                        d={roundedTop(cx - barW / 2, top, barW, h, isTop ? Math.min(4, h, barW / 2) : 0)}
                        fill={s.color}
                        opacity={hover === null || hover === i ? 1 : 0.45}
                      />
                    );
                  })}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={H - 8} textAnchor="middle" className="tick">
                      {d.date.slice(5)}
                    </text>
                  )}
                  {/* Hit target wider and taller than the marks. */}
                  <rect x={pad.left + slot * i} y={pad.top} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
          {hover !== null && data[hover] && (
            <div className="tooltip" style={{ left: `${((pad.left + slot * hover + slot / 2) / W) * 100}%` }}>
              <strong>{data[hover]!.date}</strong>
              {SERIES.map((s) => (
                <span key={s.key}>
                  <span className="swatch" style={{ background: s.color }} /> {s.label} <b>{data[hover]![s.key]}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function roundedTop(x: number, yTop: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M${x},${yTop}h${w}v${h}h${-w}z`;
  return `M${x},${yTop + h}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yTop + h}z`;
}

function niceMax(v: number): number {
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(2, step * pow);
}

const EVENT_LABELS: Record<string, [string, string]> = {
  GRANT_ISSUED: ["Grant issued", "chip"],
  GRANT_DENIED: ["Denied", "chip chip-bad"],
  RECEIPT_RECORDED: ["Signed round", "chip chip-green"],
  ORG_CREATED: ["Org registered", "chip"],
  ORG_VERIFIED: ["Org verified", "chip chip-green"],
  ORG_STATUS_CHANGED: ["Org status", "chip chip-warn"],
  AGENT_CREATED: ["Agent added", "chip"],
  AGENT_KEY_ADDED: ["Key added", "chip"],
  AGENT_KEY_REVOKED: ["Key revoked", "chip chip-warn"],
  AGENT_STATUS_CHANGED: ["Agent status", "chip chip-warn"],
  AGENT_CARD_PUBLISHED: ["Card published", "chip"],
  POLICY_UPDATED: ["Policy updated", "chip"],
  MEMBER_ADDED: ["Member added", "chip"],
  AGENT_CERTIFIED: ["Certified", "chip chip-green"],
  CERTIFICATION_FAILED: ["Certification failed", "chip chip-bad"],
  CERTIFICATION_REVOKED: ["Certification revoked", "chip chip-warn"],
  ORG_CERTIFIER_CHANGED: ["Certifier", "chip"],
};

function EventFeed({ events }: { events: AdminEvent[] }) {
  if (events.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <ul className="feed">
      {events.map((e) => {
        const [label, cls] = EVENT_LABELS[e.type] ?? [e.type, "chip"];
        const parties = [e.requesterOrg, e.providerOrg].filter(Boolean).join(" → ");
        return (
          <li key={e.id}>
            <span className={cls}>{label}</span>
            <span className="feed-main">
              {parties || <span className="muted">{e.actor}</span>}
              {detail(e) && <span className="muted"> · {detail(e)}</span>}
            </span>
            <span className="muted feed-time" title={new Date(e.createdAt).toLocaleString()}>
              {relative(e.createdAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function detail(e: AdminEvent): string {
  if (!e.details) return "";
  try {
    const d = JSON.parse(e.details) as Record<string, unknown>;
    if (e.type === "RECEIPT_RECORDED") return `round ${d.round} · ${d.status}`;
    return String(d.reason ?? d.taskType ?? d.capability ?? d.status ?? d.method ?? d.domain ?? "");
  } catch {
    return "";
  }
}

type OrgFilter = "all" | "pending" | "verified" | "suspended";

function OrgTable({ orgs, busy, act, api }: { orgs: AdminOrg[]; busy: boolean; act: (fn: () => Promise<unknown>) => void; api: Api }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<OrgFilter>("all");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orgs.filter((o) => {
      if (q && !o.name.toLowerCase().includes(q) && !o.domain.includes(q)) return false;
      if (filter === "pending") return o.verificationStatus === "PENDING";
      if (filter === "verified") return o.verificationStatus === "VERIFIED" && o.status === "ACTIVE";
      if (filter === "suspended") return o.status === "SUSPENDED";
      return true;
    });
  }, [orgs, query, filter]);

  return (
    <section className="card">
      <div className="row">
        <h2>Organizations</h2>
        <span className="muted">{rows.length} shown</span>
        <span className="spacer" />
        <input className="search" placeholder="Search name or domain" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="segmented" role="group" aria-label="Filter organizations">
          {(["all", "pending", "verified", "suspended"] as OrgFilter[]).map((f) => (
            <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
              {f[0]!.toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Organization</th>
              <th>Verification</th>
              <th>Status</th>
              <th className="num">Members</th>
              <th className="num">Agents</th>
              <th>Last activity</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>
                  <strong>{o.name}</strong> {o.certifier && <span className="chip chip-green">Certifier</span>}
                  <div className="muted">{o.domain}</div>
                </td>
                <td>
                  <span className={`badge ${o.verificationStatus === "VERIFIED" ? "ok" : "warn"}`}>{o.verificationStatus}</span>
                </td>
                <td>
                  <span className={`badge ${o.status === "ACTIVE" ? "ok" : "bad"}`}>{o.status}</span>
                </td>
                <td className="num">{o.members}</td>
                <td className="num">
                  {o.activeAgents}
                  {o.agents !== o.activeAgents && <span className="muted"> / {o.agents}</span>}
                </td>
                <td className="muted">{o.lastActivity ? relative(o.lastActivity) : "—"}</td>
                <td className="muted">{new Date(o.createdAt).toLocaleDateString()}</td>
                <td className="actions">
                  {o.verificationStatus !== "VERIFIED" && (
                    <button className="small" disabled={busy} onClick={() => act(() => api.verifyOrg(o.id, "manual"))}>
                      Verify
                    </button>
                  )}
                  {o.verificationStatus === "VERIFIED" && (
                    <button className="small" disabled={busy} onClick={() => act(() => api.setCertifier(o.id, !o.certifier))}>
                      {o.certifier ? "Remove certifier" : "Make certifier"}
                    </button>
                  )}
                  <button
                    className={`small ${o.status === "ACTIVE" ? "danger" : ""}`}
                    disabled={busy}
                    onClick={() => act(() => api.setOrgStatus(o.id, o.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"))}
                  >
                    {o.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No organizations match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The latest conformance results across the network, newest first. */
function CertificationTable({ certs, orgs, busy, act, api }: { certs: Certification[]; orgs: AdminOrg[]; busy: boolean; act: (fn: () => Promise<unknown>) => void; api: Api }) {
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  return (
    <section className="card">
      <div className="row">
        <h2>Certifications</h2>
        <span className="muted">{certs.filter((c) => c.valid).length} valid</span>
      </div>
      {certs.length === 0 ? (
        <p className="muted">No conformance results yet. Mark an organization as a certifier, then run pistiva-certify with --submit from its agent.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Task type</th>
                <th>Result</th>
                <th className="num">Checks</th>
                <th>Recorded</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{orgName.get(c.orgId) ?? c.orgId}</strong>
                    <div className="muted">
                      <code>{c.agentId.slice(0, 8)}</code>
                    </div>
                  </td>
                  <td>
                    <code>
                      {c.taskType}@{c.taskTypeVersion}
                    </code>
                  </td>
                  <td>
                    <CertBadge cert={c} />
                    {c.revokedReason && <div className="muted">{c.revokedReason}</div>}
                  </td>
                  <td className="num">
                    {c.checksPassed}/{c.checksTotal}
                  </td>
                  <td className="muted">{relative(c.createdAt)}</td>
                  <td className="muted">{new Date(c.expiresAt).toLocaleDateString()}</td>
                  <td className="actions">
                    {c.status !== "REVOKED" && (
                      <button
                        className="small danger"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt("Why is this certification being revoked?");
                          if (reason?.trim()) act(() => api.revokeCertification(c.id, reason.trim()));
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function relative(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}
