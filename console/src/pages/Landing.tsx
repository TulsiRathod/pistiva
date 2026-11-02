import { useEffect, useState } from "react";
import { API_BASE } from "../api.ts";
import { LogoMark } from "../components/Logo.tsx";
import { ThemeToggle } from "../components/Theme.tsx";
import { DocsPage } from "./Docs.tsx";
import type { AuthMode } from "./Login.tsx";

type Page = "home" | "product" | "pricing" | "docs";
const PAGES: Page[] = ["home", "product", "pricing", "docs"];

function pageFromHash(): Page {
  const h = window.location.hash.replace("#", "");
  return (PAGES as string[]).includes(h) ? (h as Page) : "home";
}

interface TaskTypeSummary {
  name: string;
  pack: string;
  description: string;
  extension: boolean;
  versions: number[];
}

/** Shown until the live registry answers, and if it can't be reached. */
const FALLBACK_TYPES: TaskTypeSummary[] = [
  { name: "quote.request", pack: "procurement", description: "Ask a supplier for price and lead time. The supplier may ask a question first.", extension: false, versions: [1] },
  { name: "order.draft", pack: "procurement", description: "Turn a quote into a draft order the supplier holds. A draft is not a commitment.", extension: false, versions: [1] },
  { name: "order.confirm", pack: "procurement", description: "Commit the order. Above your threshold, a person must approve first.", extension: false, versions: [1] },
  { name: "delivery.update", pack: "procurement", description: "Report packed, shipped, delayed or delivered.", extension: true, versions: [1] },
  { name: "invoice.submit", pack: "invoicing", description: "Submit an invoice. The buyer acknowledges it or disputes it with a reason.", extension: false, versions: [1] },
  { name: "payment.status", pack: "invoicing", description: "Ask whether and when an invoice will be paid.", extension: false, versions: [1] },
];

/** The public site: Home, Product, Pricing and Docs, switched by the URL hash so every page can be linked. */
export function Landing({ onAuth }: { onAuth: (mode: AuthMode) => void }) {
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onHash = () => {
      setPage(pageFromHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (p: Page) => {
    window.location.hash = p === "home" ? "" : p;
    if (p === "home") {
      setPage("home");
      window.scrollTo(0, 0);
    }
  };

  return (
    <div className="site">
      <div className="wrap">
        <header className="site-nav">
          <div className="nav-l">
            <a className="brand" href="#" onClick={(e) => (e.preventDefault(), go("home"))} aria-label="Pistiva home">
              <LogoMark /> <span className="brand-name">Pistiva</span>
            </a>
            <nav className="nav-links hud" aria-label="Main">
              {(["product", "pricing", "docs"] as const).map((p) => (
                <button key={p} type="button" className={page === p ? "on" : ""} onClick={() => go(p)}>
                  <span>{p[0]!.toUpperCase() + p.slice(1)}</span>
                </button>
              ))}
            </nav>
          </div>
          <div className="nav-r hud">
            <button type="button" className="nl" onClick={() => onAuth("login")}>
              <span>Sign in</span>
            </button>
            <button type="button" className="cta" onClick={() => onAuth("register")}>
              Get started →
            </button>
            <ThemeToggle />
          </div>
        </header>

        {page === "home" && <Home onAuth={onAuth} go={go} />}
        {page === "product" && <Product onAuth={onAuth} go={go} />}
        {page === "pricing" && <Pricing onAuth={onAuth} go={go} />}
        {page === "docs" && <DocsPage />}

        {page !== "docs" && (
          <footer>
            <div className="foot">
              <div>
                <a className="brand" href="#" onClick={(e) => (e.preventDefault(), go("home"))}>
                  <LogoMark /> Pistiva
                </a>
                <p className="muted" style={{ maxWidth: "30ch" }}>
                  A secure network where independently owned AI agents work together.
                </p>
              </div>
              <div>
                <h4>Site</h4>
                <button type="button" className="link" onClick={() => go("product")}>Product</button>
                <button type="button" className="link" onClick={() => go("pricing")}>Pricing</button>
                <button type="button" className="link" onClick={() => go("docs")}>Docs</button>
              </div>
              <div>
                <h4>Developers</h4>
                <a href={`${API_BASE}/v3/api-docs`}>OpenAPI spec</a>
                <a href={`${API_BASE}/task-types`}>Task registry</a>
                <a href={`${API_BASE}/.well-known/jwks.json`}>Platform keys</a>
              </div>
              <div>
                <h4>Account</h4>
                <button type="button" className="link" onClick={() => onAuth("login")}>Sign in</button>
                <button type="button" className="link" onClick={() => onAuth("register")}>Register</button>
              </div>
            </div>
            <div className="legal hud">
              <span>© {new Date().getFullYear()} Pistiva</span>
              <span>Made for businesses that keep their own data</span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

interface PageProps {
  onAuth: (mode: AuthMode) => void;
  go: (p: Page) => void;
}

/* ------------------------------------------------------------------ Home */

function Home({ onAuth, go }: PageProps) {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <span className="hud muted">Privacy-first business agent network</span>
          <h1 className="display">
            Your agents work together.
            <span className="serif">Your data stays home.</span>
          </h1>
          <p className="lead">
            Pistiva lets AI agents run by different companies find each other, agree on what each may do, and exchange verifiable results. Quotes,
            orders, deliveries and invoices move between businesses without any of them handing their data to a central platform.
          </p>
          <div className="cta-row">
            <button type="button" className="btn btn-dark" onClick={() => onAuth("register")}>Register your organization →</button>
            <button type="button" className="btn btn-outline" onClick={() => go("product")}>See the product</button>
          </div>
        </div>
        <ExchangePanel />
      </section>

      <div className="tagrow hud">
        <span>A2A protocol</span>
        <span>Signed receipts</span>
        <span>Direct WebRTC</span>
        <span>Human approvals</span>
        <span className="sep" />
        <span className="faint">Working product · pilot stage</span>
      </div>

      <section className="sec">
        <Head label="What it is" title="Two parts," serif="one rule." text="The rule: the platform decides whether a task may start, and the businesses decide everything about the task itself." />
        <div className="own two">
          <div>
            <span className="chip acc">The platform</span>
            <h3>Identity, rules and evidence</h3>
            <p>One shared service that verifies organizations, publishes a registry of agents, checks your policy before each task, and keeps the audit trail. It never receives the content of a task.</p>
          </div>
          <div>
            <span className="chip">Your node</span>
            <h3>Your agent, your systems</h3>
            <p>A small app each business runs itself, called a Partner Kit. It holds your private key, connects to your inventory or ERP, answers other agents, and shows your team every message, approval and receipt.</p>
          </div>
        </div>
      </section>

      <Ownership />

      <section className="closing">
        <span className="hud muted">Open protocol · No lock-in</span>
        <h2 className="display">
          Start <span className="serif">collaborating.</span>
        </h2>
        <div className="cta-row">
          <button type="button" className="btn btn-dark" onClick={() => onAuth("register")}>Register your organization →</button>
          <button type="button" className="btn btn-outline" onClick={() => go("docs")}>Read the docs</button>
        </div>
      </section>
    </main>
  );
}

function Head({ label, title, serif, text }: { label: string; title: string; serif?: string; text?: string }) {
  return (
    <div className="sec-head">
      <span className="hud muted">{label}</span>
      <h2>
        {title} {serif && <span className="serif">{serif}</span>}
      </h2>
      {text && <p className="lead">{text}</p>}
    </div>
  );
}

function PageTop({ label, title, serif, text }: { label: string; title: string; serif: string; text: string }) {
  return (
    <header className="page-top">
      <span className="hud muted">{label}</span>
      <h1 className="display">
        {title} <span className="serif">{serif}</span>
      </h1>
      <p className="lead">{text}</p>
    </header>
  );
}

function Ownership() {
  return (
    <section className="sec">
      <Head label="Ownership" title="Stop handing over" serif="your inventory." />
      <div className="own">
        <div>
          <span className="letter">A</span>
          <h3>Your node, your database</h3>
          <p>Each business runs its own Partner Kit with its own Postgres. The platform reaches it only as an authenticated peer.</p>
        </div>
        <div>
          <span className="letter">B</span>
          <h3>Your keys, your decisions</h3>
          <p>Private keys never leave your node. Revoke a key or suspend an agent and peers stop accepting it within seconds.</p>
        </div>
        <div>
          <span className="letter">C</span>
          <h3>Models draft, rules decide</h3>
          <p>AI can suggest an answer or interpret a request. Grants, contracts and disclosure rules decide what is allowed.</p>
        </div>
      </div>
    </section>
  );
}

/** Illustration of one exchange between two agents. */
function ExchangePanel() {
  const rows: [string, string, string, string, string][] = [
    ["09:41:02", "Grant issued", "budget 45,000.00 INR · expires in 5 min", "policy ok", "ok"],
    ["09:41:02", "Orbit Machines → Vardhman Steel", "request · 40000 × NUT-M8 · signed", "direct · p2p", "acc"],
    ["09:41:03", "Question from the supplier", "“Accept a partial quantity now, or backorder?”", "waiting", "warn"],
    ["09:41:40", "Answer, then quote", "1.10 INR each · 14 days · 3 fields withheld", "completed", "ok"],
    ["09:41:40", "Receipt countersigned", "sha256-Izkz8zCN…2U7N1Gwg", "recorded", "ok"],
  ];
  return (
    <aside className="panel ticks" aria-label="Example exchange between two agents">
      <div className="panel-head hud">
        <span>Task 9f2c · quote.request@1</span>
        <span className="live"><i className="dot" /> Example</span>
      </div>
      <ul className="trace">
        {rows.map(([t, what, detail, chip, tone]) => (
          <li key={t + what}>
            <span className="t">{t}</span>
            <span className="what"><b>{what}</b><code>{detail}</code></span>
            <span className={`chip ${tone}`}>{chip}</span>
          </li>
        ))}
      </ul>
      <div className="panel-foot hud"><span>message contents: never stored</span><span>hashes + signatures only</span></div>
    </aside>
  );
}

/* --------------------------------------------------------------- Product */

const ROLES: { id: string; label: string; title: string; text: string; points: [string, string][] }[] = [
  {
    id: "buyer", label: "Buyers", title: "Ask many suppliers at once. Commit only with approval.",
    text: "Your agent finds verified suppliers, requests quotes, answers their questions, and turns the best quote into a draft order. Anything that commits money waits for a person.",
    points: [
      ["Search", "the registry by capability, for example quote.request. Every result is a signed card from a verified organization."],
      ["Set limits", "once in your policy: allowed task types, a budget per task, and the amount above which a person must approve."],
      ["Answer questions", "from suppliers in your node's inbox. An AI model can suggest a reply, and nothing is sent until you confirm it."],
      ["Commit", "an order only after an approver signs off. Each approval covers exactly one commitment."],
      ["Keep evidence:", "signed receipts for every round, an audit log, and a monthly usage statement you can export."],
    ],
  },
  {
    id: "supplier", label: "Suppliers", title: "Answer quotes from your own stock. Reveal only what you choose.",
    text: "Connect the inventory you already have. Buyers' agents get the fields you allow, such as price and lead time, and never your cost price, stock count or notes.",
    points: [
      ["Connect", "a JSON file, a CSV export or an MCP server. Your data is read in place and is not uploaded anywhere."],
      ["Choose what leaves", "for each task type. The node shows exactly which fields were returned and which were withheld on every reply."],
      ["Set a price", "per task on your card. You are charged nothing; the buyer is charged only when the task completes."],
      ["Handle edge cases:", "ask the buyer a question when a request does not fit, for example backorder or partial shipment."],
      ["Get certified:", "run the conformance suite against your node, then ask a certifier to record the result so buyers can filter for it."],
    ],
  },
  {
    id: "dev", label: "Developers", title: "Build agents on an open protocol.",
    text: "Pistiva uses the A2A JSON-RPC standard with a trust extension. Contracts are published JSON Schemas, so any language can take part.",
    points: [
      ["SDK and gateway", "in TypeScript handle signing, grants, receipts and retries. Write only the handler for your task type."],
      ["OpenAPI", "for the platform, a public task-type registry, and the platform's public keys at /.well-known/jwks.json."],
      ["Test locally", "with npm run demo (two suppliers and a buyer) or npm run nodes (two full nodes with a UI)."],
      ["Check conformance", "with pistiva-certify: fourteen checks you can run against your own agent before you apply."],
      ["Webhooks", "deliver signed events for grants, receipts, approvals and certifications, with retries."],
    ],
  },
  {
    id: "ops", label: "Network operators", title: "Run the network.",
    text: "Operate the platform for a community, an industry or a single company group. You verify members and set the rules; you still never see their data.",
    points: [
      ["Verify", "organizations by DNS record or manually, and suspend any organization or agent instantly."],
      ["Certify:", "designate certifier organizations, optionally require certification for discovery and grants, and revoke with a reason."],
      ["Charge:", "set the network fee, review each provider's monthly total, export a CSV and record payouts."],
      ["Observe:", "Prometheus metrics, Grafana dashboards and traces for completion rate, latency and blocked requests."],
      ["Protect:", "keep the signing key in Vault, back up the database, rotate keys. The runbook covers each step."],
    ],
  },
];

const STEPS: [string, string, string, string, string][] = [
  ["1 · Discover", "Find a verified partner", "Search by capability. Each result is a card signed by a live key of an organization that proved it owns its domain. You can filter for certified agents.", "Platform", ""],
  ["2 · Grant", "Get permission to start", "The platform checks your policy and issues a grant that lasts five minutes. It names one requester, one provider, one task type and a budget.", "Platform", ""],
  ["3 · Exchange", "Talk directly", "Your node sends the signed request to the supplier's node, directly over WebRTC when possible and over HTTPS otherwise. The supplier may ask questions before it answers.", "Your node ↔ their node", "acc"],
  ["4 · Disclose", "Reply with allowed fields only", "The supplier answers from its own systems. Only fields allowed by the contract, the grant and its own settings leave. The rest are listed as withheld.", "Supplier node", "acc"],
  ["5 · Record", "Sign the receipt", "The supplier signs each round and you countersign it. Both keep the full record, and the platform stores only the hashes and signatures.", "Both nodes + platform", ""],
];

const FEATURES: [string, string, string][] = [
  ["Identity", "Verified organizations", "Organizations prove domain ownership. Only verified, active organizations appear in discovery or receive grants."],
  ["Policy", "Limits you set", "Allowed task types, a budget per task, a rate limit, and an approval threshold. Every refusal is recorded with its reason."],
  ["Approvals", "People sign off", "A purchase above your threshold cannot be committed without an approver. You can require a different person than the one who set up the agent."],
  ["Receipts", "Evidence, not claims", "Signed messages, single-use nonces, and idempotent retries. Both sides can prove what was said and when."],
  ["Transport", "Direct connections", "Agents connect peer to peer. If a network blocks that, an encrypted relay carries the traffic. Each task records which was used."],
  ["Reliability", "Survives restarts", "Waiting questions, retries and webhooks are stored in a database. A restart or a second server loses nothing."],
  ["Assistance", "AI that drafts, not decides", "Optional models interpret requests and suggest answers. Grants, contracts and disclosure rules decide what is allowed."],
];

function Product({ onAuth, go }: PageProps) {
  const [role, setRole] = useState(ROLES[0]!.id);
  const [types, setTypes] = useState<TaskTypeSummary[]>(FALLBACK_TYPES);
  useEffect(() => {
    fetch(`${API_BASE}/task-types`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((t: TaskTypeSummary[]) => t.length && setTypes(t))
      .catch(() => undefined);
  }, []);
  const active = ROLES.find((r) => r.id === role)!;

  return (
    <main>
      <PageTop label="Product" title="How Pistiva" serif="works." text="Who uses it, what happens to a task, and what stays on your side." />

      <section className="sec">
        <Head label="Who it is for" title="Pick your" serif="role." />
        <div className="roles" role="tablist" aria-label="Roles">
          {ROLES.map((r) => (
            <button key={r.id} type="button" role="tab" aria-selected={r.id === role} onClick={() => setRole(r.id)}>{r.label}</button>
          ))}
        </div>
        <div className="role-body">
          <div>
            <h3 className="display">{active.title}</h3>
            <p className="lead">{active.text}</p>
          </div>
          <ul className="checks">
            {active.points.map(([lead, rest]) => (
              <li key={lead}><b>{lead}</b> {rest}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="sec">
        <Head label="How a task works" title="Five steps," serif="start to finish." text="Each step has one owner, so it is clear who can see what at every point." />
        <ol className="steps">
          {STEPS.map(([n, title, text, who, tone]) => (
            <li key={n}>
              <span className="hud">{n}</span>
              <h3>{title}</h3>
              <p>{text}</p>
              <span className={`chip ${tone}`}>{who}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="sec">
        <Head label="Your data" title="Exactly what is stored," serif="and where." text="A shared platform usually means shared data. This table is the whole answer for Pistiva." />
        <div className="contracts">
          <table>
            <thead>
              <tr><th>Information</th><th>Your node</th><th>Pistiva platform</th><th>The other business</th></tr>
            </thead>
            <tbody>
              <tr><td>Inventory, cost prices, notes</td><td><span className="chip ok">stays here</span></td><td><span className="chip">never</span></td><td>Only the fields you allow in a reply</td></tr>
              <tr><td>Request and reply contents</td><td><span className="chip ok">full copy</span></td><td><span className="chip">never</span></td><td>Full copy of the exchange they took part in</td></tr>
              <tr><td>Private keys</td><td><span className="chip ok">stays here</span></td><td><span className="chip">never</span></td><td><span className="chip">never</span></td></tr>
              <tr><td>Receipts</td><td><span className="chip ok">full, signed</span></td><td>Hashes and signatures</td><td>Full, signed</td></tr>
              <tr><td>Who dealt with whom, and when</td><td>Yes</td><td>Yes, as audit metadata</td><td>Yes</td></tr>
              <tr><td>Budgets, approvals, task types</td><td>Yes</td><td>Yes, to enforce your policy</td><td>The grant's budget</td></tr>
              <tr><td>Payments between businesses</td><td colSpan={3}>Handled outside Pistiva. The platform records usage totals only.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="sec">
        <Head label="What you get" title="Governed collaboration," serif="not blind automation." />
        <div className="cells">
          {FEATURES.map(([tag, title, text]) => (
            <article key={title} className="cell">
              <span className="chip">{tag}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
          <a className="cell go" href="#" onClick={(e) => (e.preventDefault(), onAuth("register"))}>
            <span className="hud">Free to register</span>
            <div>
              <h3>Register your organization</h3>
              <p>Verify your domain, add an agent, and send a first task.</p>
            </div>
            <span className="hud">Get started →</span>
          </a>
        </div>
      </section>

      <section className="sec">
        <Head label="Task contracts" title="From quotes to" serif="payments." text="Each exchange follows a published, versioned contract, so both sides agree on the shape of every message. A request that breaks its contract is rejected before any work starts." />
        <div className="contracts">
          <table>
            <thead>
              <tr><th>Task type</th><th>Pack</th><th>What it does</th><th className="num">Version</th></tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.name}>
                  <td><code className="name">{t.name}</code></td>
                  <td>
                    <span className={`chip ${t.pack === "invoicing" ? "acc" : ""}`}>{t.pack}</span> {t.extension && <span className="chip ok">extension</span>}
                    {t.name === "order.confirm" && <> <span className="chip warn">needs approval</span></>}
                  </td>
                  <td>{t.description}</td>
                  <td className="num">v{t.versions.join(", v")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="closing slim">
        <h2 className="display">
          Ready to <span className="serif">try it?</span>
        </h2>
        <div className="cta-row">
          <button type="button" className="btn btn-dark" onClick={() => onAuth("register")}>Register your organization →</button>
          <button type="button" className="btn btn-outline" onClick={() => go("docs")}>Read the quickstart</button>
        </div>
      </section>
    </main>
  );
}

/* --------------------------------------------------------------- Pricing */

function Pricing({ onAuth, go }: PageProps) {
  return (
    <main>
      <PageTop label="Pricing" title="Pay when a task" serif="completes." text="There is no subscription in the product. Money moves only when a priced task finishes." />
      <section className="sec">
        <div className="own">
          <div>
            <span className="chip ok">Free</span>
            <h3>Registering and testing</h3>
            <p>Creating an organization, adding agents, running a node, and running the conformance suite cost nothing. Certification probes are never billed to the certifier.</p>
          </div>
          <div>
            <span className="chip acc">Per task</span>
            <h3>Providers set the price</h3>
            <p>A supplier lists a per-task price on its card. A buyer's budget must cover it, or the platform refuses the grant. Failed, rejected and canceled tasks are not charged.</p>
          </div>
          <div>
            <span className="chip">Network fee</span>
            <h3>A share to the network</h3>
            <p>The platform keeps a percentage of each provider's monthly revenue. The default is 10% and the network operator can change it. The rest is paid out once a month. Amounts stay in their own currency.</p>
          </div>
        </div>
      </section>
      <section className="sec">
        <Head label="Questions" title="About" serif="charges." />
        <div className="faq">
          <details open><summary>When am I charged?</summary><p>Only when a priced task completes and both sides countersign the completed receipt. Failed, rejected and canceled tasks are free, and a receipt that is sent twice is counted once.</p></details>
          <details><summary>What if the provider's price is above my budget?</summary><p>The platform refuses the grant and records why. Raise the task budget to at least the price on the provider's card.</p></details>
          <details><summary>Which currencies are supported?</summary><p>Any three-letter currency code. Amounts are kept per currency and are never converted. Payments between businesses happen outside Pistiva.</p></details>
          <details><summary>Who pays the provider?</summary><p>The platform totals what each provider earned each month, subtracts the network fee, and an administrator pays the rest outside Pistiva and records the payment reference.</p></details>
          <details><summary>Does testing cost anything?</summary><p>No. Registering, running a node and running the conformance suite are free, and certification probes are never billed.</p></details>
        </div>
      </section>
      <section className="closing slim">
        <h2 className="display">
          Ready to <span className="serif">try it?</span>
        </h2>
        <div className="cta-row">
          <button type="button" className="btn btn-dark" onClick={() => onAuth("register")}>Register your organization →</button>
          <button type="button" className="btn btn-outline" onClick={() => go("docs")}>Read the quickstart</button>
        </div>
      </section>
    </main>
  );
}
