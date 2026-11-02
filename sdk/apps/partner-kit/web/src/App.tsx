import { LogoMark, LogoSprite } from "./components/Logo.tsx";
import { ThemeToggle } from "./components/Theme.tsx";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { NodeApi, type NodeInfo } from "./api.ts";
import { Activity } from "./pages/Activity.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Questions } from "./pages/Questions.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Tasks } from "./pages/Tasks.tsx";
import { useAction } from "./useAsync.ts";

const TOKEN_KEY = "pistiva.node.token";
export type Tab = "overview" | "inbox" | "outbox" | "questions" | "settings" | "activity";

const ic = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const NAV: [Tab, string, ReactNode][] = [
  ["overview", "Overview", <svg {...ic}><path d="M4 21V10l8-6 8 6v11" /><path d="M9 21v-6h6v6" /></svg>],
  ["inbox", "Inbox", <svg {...ic}><path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 5h14l2 8v6H3v-6z" /></svg>],
  ["outbox", "Outbox", <svg {...ic}><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></svg>],
  ["questions", "Questions", <svg {...ic}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.7-2.5 2-2.5 3.5M12 17h.01" /></svg>],
  ["settings", "Disclosure & data", <svg {...ic}><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /></svg>],
  ["activity", "Activity log", <svg {...ic}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></svg>],
];

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [token, setToken] = useState<string | null>(readToken);
  const [info, setInfo] = useState<NodeInfo | undefined>();
  const [tab, setTab] = useState<Tab>("overview");
  const api = useMemo(() => new NodeApi(token), [token]);

  useEffect(() => {
    if (!token) return;
    const load = () => api.me().then(setInfo).catch(() => signOut());
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [api, token]);

  function signIn(t: string) {
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* keep in memory */
    }
    setToken(t);
  }

  function signOut() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setToken(null);
    setInfo(undefined);
  }

  if (!token) return <Login api={api} onToken={signIn} />;
  if (!info) return <main className="center muted">Loading…</main>;

  const [, title] = NAV.find(([id]) => id === tab)!;
  return (
    <div className="app">
      <LogoSprite />
      <aside className="sidebar">
        <div className="brand">
          <LogoMark /> Pistiva <span className="chip">node</span>
        </div>
        <div className="node-id">
          <strong>{info.agent.name}</strong>
          <span className="muted" title={info.agent.agentId}>
            agent {info.agent.agentId.slice(0, 8)}
          </span>
        </div>
        <nav className="side-nav">
          {NAV.map(([id, label, icon]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {icon} {label}
              {id === "questions" && info.counts.openQuestions > 0 && <span className="count">{info.counts.openQuestions}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <span className="avatar">O</span>
          <div className="who">
            <strong>Operator</strong>
            <span className="muted">this node only</span>
          </div>
          <ThemeToggle className="icon-btn" />
          <button className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out" style={{ marginLeft: 0 }}>
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
            <p className="muted">{SUBTITLES[tab]}</p>
          </div>
        </div>
        {tab === "overview" && <Overview api={api} info={info} go={setTab} />}
        {tab === "inbox" && <Tasks api={api} direction="inbound" info={info} />}
        {tab === "outbox" && <Tasks api={api} direction="outbound" info={info} />}
        {tab === "questions" && <Questions api={api} />}
        {tab === "settings" && <Settings api={api} />}
        {tab === "activity" && <Activity api={api} />}
      </main>
    </div>
  );
}

const SUBTITLES: Record<Tab, string> = {
  overview: "What this node is doing for your business",
  inbox: "Requests other businesses' agents sent to you, and what you disclosed",
  outbox: "Requests your agent sent to suppliers",
  questions: "Suppliers are waiting for your answer before they can quote",
  settings: "What leaves your systems, and where your data comes from",
  activity: "This node's own detailed log. It never leaves your infrastructure.",
};

function Login({ api, onToken }: { api: NodeApi; onToken: (t: string) => void }) {
  const [password, setPassword] = useState("");
  const { run, error, busy } = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => onToken((await api.login(password)).token));
  }
  return (
    <main className="center node-login">
      <LogoSprite />
      <form className="modal" onSubmit={submit}>
        <div className="brand">
          <LogoMark /> Pistiva <span className="chip">node</span>
        </div>
        <h2>Operator sign-in</h2>
        <p className="muted">This node runs on your own infrastructure. Use the operator password set in KIT_ADMIN_PASSWORD.</p>
        <label>
          Password
          <input type="password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-dark btn-block" disabled={busy}>
          Sign in <span aria-hidden>→</span>
        </button>
      </form>
    </main>
  );
}


export function relative(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function StateBadge({ state }: { state: string }) {
  const cls = state === "completed" ? "ok" : state === "input-required" || state === "submitted" || state === "working" ? "warn" : "bad";
  return <span className={`badge ${cls}`}>{state}</span>;
}
