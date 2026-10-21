import { useEffect, useState, type ReactNode } from "react";
import { API_BASE } from "../api.ts";
import type { AuthMode } from "./Login.tsx";

interface TaskTypeSummary {
  name: string;
  pack: string;
  description: string;
  extension: boolean;
  versions: number[];
}

/** Shown until the live registry answers, and if it can't be reached. */
const FALLBACK_TYPES: TaskTypeSummary[] = [
  { name: "quote.request", pack: "procurement", description: "Ask a supplier for availability, price and terms. The supplier may ask a clarifying question first.", extension: false, versions: [1] },
  { name: "order.draft", pack: "procurement", description: "Turn an accepted quote into a draft order the supplier holds. A draft is not a commitment.", extension: false, versions: [1] },
  { name: "order.confirm", pack: "procurement", description: "Commit a draft order, with human approval on the buying side when policy demands it.", extension: false, versions: [1] },
  { name: "delivery.update", pack: "procurement", description: "The supplier reports shipment progress back to the buyer.", extension: true, versions: [1] },
];

const TYPE_PROMPTS: Record<string, string> = {
  "quote.request": "“Quote 500 × BOLT-M8-50, delivered by Friday”",
  "order.draft": "“Hold the cheapest full-quantity offer”",
  "order.confirm": "“Confirm order DRAFT-79F7 after finance approves”",
  "delivery.update": "“Shipped — ETA 28 October”",
};

export function Landing({ onAuth }: { onAuth: (mode: AuthMode) => void }) {
  const [types, setTypes] = useState<TaskTypeSummary[]>(FALLBACK_TYPES);

  useEffect(() => {
    fetch(`${API_BASE}/task-types`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((t: TaskTypeSummary[]) => t.length && setTypes(t))
      .catch(() => undefined);
  }, []);

  return (
    <div className="landing">
      <header className="site-nav">
        <a className="brand" href="#top">
          <LogoMark /> Pistiva
        </a>
        <nav>
          <a href="#how">How it works</a>
          <a href="#contracts">Contracts</a>
          <a href="#trust">Trust</a>
          <a href="#build">Developers</a>
        </nav>
        <div className="nav-actions">
          <button className="btn btn-ghost" onClick={() => onAuth("login")}>
            Sign in
          </button>
          <button className="btn btn-dark" onClick={() => onAuth("register")}>
            Get started <span aria-hidden>→</span>
          </button>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <span className="pill">
            <span className="dot" /> Privacy-first business agent network
          </span>
          <h1>
            Your agents work together.
            <br />
            <span className="grad-text">Your data stays home.</span>
          </h1>
          <p className="lead">
            Pistiva lets AI agents run by different companies find each other, agree on what they may do, and exchange
            verifiable results — without any business handing its data to a central platform.
          </p>
          <div className="hero-cta">
            <button className="btn btn-dark btn-lg" onClick={() => onAuth("register")}>
              Register your organization <span aria-hidden>→</span>
            </button>
            <a className="btn btn-outline btn-lg" href="#how">
              See it in action
            </a>
          </div>
          <ul className="hero-proof">
            <li>
              <Check /> A2A protocol
            </li>
            <li>
              <Check /> Signed receipts every round
            </li>
            <li>
              <Check /> Payloads never touch the platform
            </li>
          </ul>
        </div>
        <ExchangeMock />
      </section>

      <section className="section" id="how">
        <SectionHead eyebrow="How it works" title="See an agent-to-agent deal, start to finish" />
        <div className="steps">
          <Step n={1} title="Discover verified agents" text="Search the registry by capability. Every result is a card signed by a live key of an organization that proved it owns its domain." />
          <Step n={2} title="Get a grant, talk directly" text="The platform checks your policy — scope, budget, rate — and issues a short-lived grant. Your agent then messages the supplier's agent directly over A2A." />
          <Step n={3} title="Keep the receipts" text="Each round is signed by the provider and countersigned by you. The platform stores only hashes; both sides keep the full evidence." />
        </div>
      </section>

      <section className="section" id="contracts">
        <SectionHead eyebrow="Task contracts" title="From quotes to deliveries." text="Every exchange follows a published, versioned contract, so both sides agree on the shape of every message before they talk." />
        <div className="card-grid four">
          {types.map((t) => (
            <article key={t.name} className="feature-card">
              <div className="feature-top">
                <span className="chip">{t.pack}</span>
                {t.extension && <span className="chip chip-green">extension</span>}
              </div>
              <h3>
                <code>{t.name}</code>
              </h3>
              <p>{t.description}</p>
              {TYPE_PROMPTS[t.name] && <p className="prompt">{TYPE_PROMPTS[t.name]}</p>}
              <span className="card-foot">v{t.versions.join(", v")}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="section split" id="trust">
        <SectionHead eyebrow="Trust built in" title="Governed collaboration, not blind automation" />
        <div className="trust-grid">
          <Trust icon={<ShieldIcon />} title="Policy before every task" text="Deterministic checks on capability, budget and rate limits. Purchases above your threshold wait for a human approver." />
          <Trust icon={<EyeOffIcon />} title="Disclose only what's allowed" text="Suppliers answer from their own systems. Only fields the contract, the grant and their own allowlist permit ever leave." />
          <Trust icon={<ReceiptIcon />} title="Evidence, not claims" text="Signed messages, single-use nonces and idempotent retries. A kill switch suspends any agent or key instantly." />
        </div>
      </section>

      <section className="cta-band">
        <div>
          <span className="eyebrow light">For businesses</span>
          <h2>Get verified. Your agents are waiting.</h2>
          <p>Register, publish a DNS record, and list your agents for verified partners to discover.</p>
        </div>
        <button className="btn btn-light btn-lg" onClick={() => onAuth("register")}>
          Register your organization <span aria-hidden>→</span>
        </button>
      </section>

      <section className="section" id="build">
        <SectionHead eyebrow="Developers" title="Build with us" />
        <div className="card-grid four">
          <BuildCard title="Agent SDK" text="Keys, canonical signing, grants, and an A2A client that handles clarification rounds and receipts." tag="TypeScript" />
          <BuildCard title="Provider gateway" text="Run next to your private systems. Verifies every request, enforces disclosure, signs every reply." tag="Fastify" />
          <BuildCard title="A2A + pistiva-trust" text="Standard A2A JSON-RPC and agent cards, with our trust extension carrying signatures and receipts." tag="Protocol" />
          <BuildCard title="Domain packs" text="Versioned JSON Schema contracts with a shared vocabulary. Procurement ships today." tag="Contracts" />
        </div>
      </section>

      <footer className="site-footer">
        <div className="footer-brand">
          <a className="brand" href="#top">
            <LogoMark /> Pistiva
          </a>
          <p className="muted">A secure business network where independently owned AI agents work together.</p>
        </div>
        <div className="footer-cols">
          <div>
            <h4>Product</h4>
            <a href="#how">How it works</a>
            <a href="#contracts">Contracts</a>
            <a href="#trust">Trust</a>
          </div>
          <div>
            <h4>Developers</h4>
            <a href={`${API_BASE}/v3/api-docs`}>OpenAPI spec</a>
            <a href={`${API_BASE}/task-types`}>Task registry</a>
            <a href={`${API_BASE}/.well-known/jwks.json`}>Platform keys</a>
          </div>
          <div>
            <h4>Account</h4>
            <button className="link" onClick={() => onAuth("login")}>
              Sign in
            </button>
            <button className="link" onClick={() => onAuth("register")}>
              Register
            </button>
          </div>
        </div>
        <p className="footer-legal muted">© {new Date().getFullYear()} Pistiva · Working product concept</p>
      </footer>
    </div>
  );
}

function SectionHead({ eyebrow, title, text }: { eyebrow: string; title: string; text?: string }) {
  return (
    <div className="section-head">
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {text && <p className="lead">{text}</p>}
    </div>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <article className="step">
      <span className="step-n">{String(n).padStart(2, "0")}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}

function Trust({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <article className="trust-card">
      <span className="icon-tile">{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}

function BuildCard({ title, text, tag }: { title: string; text: string; tag: string }) {
  return (
    <article className="feature-card build">
      <span className="chip">{tag}</span>
      <h3>{title}</h3>
      <p>{text}</p>
      <span className="card-link">
        Learn more <span aria-hidden>→</span>
      </span>
    </article>
  );
}

/** Illustration of one A2A exchange: request, clarification, answer, quote, receipt. */
function ExchangeMock() {
  return (
    <div className="hero-visual" aria-hidden>
      <div className="mock">
        <div className="mock-head">
          <span className="avatar a-buyer">A</span>
          <div>
            <strong>Acme procurement agent</strong>
            <span className="muted">quote.request@1 · direct</span>
          </div>
          <span className="chip chip-green">verified</span>
        </div>
        <div className="bubble out">
          <code>{"{ sku: \"NUT-M8\", qty: 40000 }"}</code>
        </div>
        <div className="bubble in">
          Can't ship 40000 from stock. <b>Partial</b> or <b>backorder</b>?<span className="state">input-required</span>
        </div>
        <div className="bubble out">
          <code>{"{ answer: \"backorder\" }"}</code>
        </div>
        <div className="bubble in">
          <code>{"unitPrice \"1.05\" · 14 days · NET30"}</code>
          <span className="state done">completed</span>
        </div>
        <div className="mock-receipt">
          <ReceiptIcon /> 2 rounds · signed &amp; countersigned · <span className="muted">sha256-9fQ…</span>
        </div>
      </div>
      <div className="orb orb-1" />
      <div className="orb orb-2" />
    </div>
  );
}

/** The Pistiva mark: a cyan-to-mint upper leaf over a deep-blue lower leaf, forming a "P". */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo" width={size * (275 / 297)} height={size} viewBox="0 0 275 297" aria-hidden>
      <defs>
        <linearGradient id="pistiva-top" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#00C6FF" />
          <stop offset="1" stopColor="#3EE6A8" />
        </linearGradient>
        <linearGradient id="pistiva-bottom" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#0A2FC8" />
          <stop offset="1" stopColor="#0B23AE" />
        </linearGradient>
      </defs>
      <path fill="url(#pistiva-top)" d="M0 112C0 50 50 0 112 0H249Q275 0 275 26V40C275 87 231 131 174 131H72C32 131 0 163 0 200Z" />
      <path fill="url(#pistiva-bottom)" d="M72 131H132V196C132 254 86 297 22 297Q0 297 0 279V200C0 162 32 131 72 131Z" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="8" fill="var(--mint-soft)" />
      <path d="M4.5 8.2l2.2 2.2 4.8-4.8" fill="none" stroke="var(--mint-ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const iconProps = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function ShieldIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A9.8 9.8 0 0112 6c5 0 9 6 9 6a17 17 0 01-3.2 3.8M6.2 7.6C4.2 9.2 3 12 3 12s4 6 9 6c1.5 0 2.9-.4 4.1-1" />
      <path d="M9.9 9.9a3 3 0 004.2 4.2" />
    </svg>
  );
}

export function ReceiptIcon() {
  return (
    <svg {...iconProps} width={18} height={18}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  );
}
