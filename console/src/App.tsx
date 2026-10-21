import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Api, type Me } from "./api.ts";
import { Admin } from "./pages/Admin.tsx";
import { Agents } from "./pages/Agents.tsx";
import { Audit } from "./pages/Audit.tsx";
import { Landing, LogoMark } from "./pages/Landing.tsx";
import { Login, type AuthMode } from "./pages/Login.tsx";
import { Overview } from "./pages/Overview.tsx";
import { PolicyPage } from "./pages/PolicyPage.tsx";

const TOKEN_KEY = "pistiva.token";
type Tab = "overview" | "agents" | "policy" | "audit" | "admin";

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const ic = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const ICONS: Record<Tab, ReactNode> = {
  overview: (
    <svg {...ic}>
      <path d="M4 21V10l8-6 8 6v11" />
      <path d="M9 21v-6h6v6" />
    </svg>
  ),
  agents: (
    <svg {...ic}>
      <rect x="5" y="7" width="14" height="11" rx="3" />
      <path d="M12 3v4M9 12h.01M15 12h.01M9.5 15h5" />
    </svg>
  ),
  policy: (
    <svg {...ic}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
    </svg>
  ),
  audit: (
    <svg {...ic}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  ),
  admin: (
    <svg {...ic}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 15H3a2 2 0 110-4h.1a1.7 1.7 0 001.2-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 009 3V3a2 2 0 114 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1A1.7 1.7 0 0021 11h.1a2 2 0 110 4z" />
    </svg>
  ),
};

const TITLES: Record<Tab, [string, string]> = {
  overview: ["Organization", "Identity, verification and status of your organization"],
  agents: ["Agents", "Register agents, manage their keys and use the kill switch"],
  policy: ["Policy", "Rules the platform checks before every task grant"],
  audit: ["Audit log", "Grants, denials and signed receipts — metadata only"],
  admin: ["Admin dashboard", "Network health, verification queue and organization management"],
};

export function App() {
  const [token, setToken] = useState<string | null>(readToken);
  const [me, setMe] = useState<Me | undefined>();
  const [orgId, setOrgId] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>("overview");
  const [auth, setAuth] = useState<AuthMode | null>(null);
  const api = useMemo(() => new Api(token), [token]);

  useEffect(() => {
    if (!token) return;
    api
      .me()
      .then((m) => {
        setMe(m);
        setOrgId((current) => current ?? m.organizations[0]?.orgId);
        if (m.platformAdmin && m.organizations.length === 0) setTab("admin");
      })
      .catch(() => signOut());
  }, [api, token]);

  function signIn(t: string) {
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* private mode: keep the session in memory only */
    }
    setAuth(null);
    setToken(t);
  }

  function signOut() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setToken(null);
    setMe(undefined);
    setOrgId(undefined);
    setTab("overview");
  }

  if (!token) {
    return (
      <>
        <Landing onAuth={setAuth} />
        {auth && <Login api={api} onToken={signIn} initialMode={auth} onClose={() => setAuth(null)} />}
      </>
    );
  }
  if (!me) return <main className="center muted">Loading…</main>;

  const membership = me.organizations.find((o) => o.orgId === orgId);
  const tabs: Tab[] = ["overview", "agents", "policy", "audit", ...(me.platformAdmin ? (["admin"] as Tab[]) : [])];
  const [title, subtitle] = TITLES[tab];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <LogoMark /> Pistiva
        </div>
        {me.organizations.length > 0 && (
          <label className="org-switch">
            <span>Organization</span>
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {me.organizations.map((o) => (
                <option key={o.orgId} value={o.orgId}>
                  {o.orgName}
                </option>
              ))}
            </select>
          </label>
        )}
        <nav className="side-nav">
          {tabs.map((id) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {ICONS[id]} {TITLES[id][0]}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <span className="avatar">{me.email[0]?.toUpperCase()}</span>
          <div className="who">
            <strong title={me.email}>{me.email}</strong>
            <span className="muted">{me.platformAdmin ? "Platform admin" : membership?.role.toLowerCase()}</span>
          </div>
          <button className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out">
            <svg {...ic}>
              <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H4" />
            </svg>
          </button>
        </div>
      </aside>
      <main className="content">
        <div className="page-head">
          <div>
            <h1>{title}</h1>
            <p className="muted">{subtitle}</p>
          </div>
          {membership && tab !== "admin" && (
            <span className={`chip ${membership.verificationStatus === "VERIFIED" ? "chip-green" : "chip-warn"}`}>
              {membership.verificationStatus === "VERIFIED" ? "Verified organization" : "Verification pending"}
            </span>
          )}
        </div>
        {tab === "admin" && me.platformAdmin && <Admin api={api} />}
        {tab !== "admin" && !membership && (
          <div className="card empty">
            <h3>No organization yet</h3>
            <p className="muted">This account isn't a member of any organization.{me.platformAdmin ? " Use Platform admin to manage the network." : ""}</p>
          </div>
        )}
        {tab === "overview" && membership && <Overview api={api} orgId={membership.orgId} />}
        {tab === "agents" && membership && <Agents api={api} orgId={membership.orgId} />}
        {tab === "policy" && membership && <PolicyPage api={api} orgId={membership.orgId} role={membership.role} />}
        {tab === "audit" && membership && <Audit api={api} orgId={membership.orgId} />}
      </main>
    </div>
  );
}
