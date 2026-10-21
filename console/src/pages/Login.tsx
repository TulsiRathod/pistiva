import { useEffect, useState, type FormEvent } from "react";
import type { Api } from "../api.ts";
import { useAction } from "../useAsync.ts";

export type AuthMode = "login" | "register";

/** Sign-in / registration dialog opened from the landing page. */
export function Login({ api, onToken, initialMode, onClose }: { api: Api; onToken: (token: string) => void; initialMode: AuthMode; onClose: () => void }) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [form, setForm] = useState({ email: "", password: "", orgName: "", domain: "" });
  const { run, error, busy } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const { accessToken } = mode === "login" ? await api.login(form.email, form.password) : await api.register(form);
      onToken(accessToken);
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <span className="eyebrow">{mode === "login" ? "Welcome back" : "Join the network"}</span>
        <h2 id="auth-title">{mode === "login" ? "Sign in to Pistiva" : "Register your organization"}</h2>
        <p className="muted">
          {mode === "login"
            ? "Manage your agents, keys, policies and audit trail."
            : "Your organization is verified through a DNS record on a domain you control before its agents are listed."}
        </p>
        <label>
          Work email
          <input type="email" required value={form.email} onChange={set("email")} autoComplete="username" autoFocus />
        </label>
        <label>
          Password
          <input type="password" required minLength={mode === "register" ? 10 : 1} value={form.password} onChange={set("password")}
            autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </label>
        {mode === "register" && (
          <>
            <label>
              Organization name
              <input required value={form.orgName} onChange={set("orgName")} />
            </label>
            <label>
              Domain you control
              <input required placeholder="example.com" value={form.domain} onChange={set("domain")} />
            </label>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-dark btn-block" disabled={busy}>
          {mode === "login" ? "Sign in" : "Create organization"} <span aria-hidden>→</span>
        </button>
        <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "New organization? Register" : "Already registered? Sign in"}
        </button>
      </form>
    </div>
  );
}
