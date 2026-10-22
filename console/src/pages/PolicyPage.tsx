import { useEffect, useState, type FormEvent } from "react";
import type { Api, Policy, Role } from "../api.ts";
import { useAction, useAsync } from "../useAsync.ts";

export function PolicyPage({ api, orgId, role }: { api: Api; orgId: string; role: Role }) {
  const { data, error, reload } = useAsync(() => api.policy(orgId), [api, orgId]);
  const [draft, setDraft] = useState<Policy | undefined>();
  const [capabilities, setCapabilities] = useState("");
  const save = useAction();
  const canEdit = role === "OWNER" || role === "ADMIN";

  useEffect(() => {
    if (data) {
      setDraft({ ...data, maxBudgetPerTask: String(data.maxBudgetPerTask), approvalThreshold: String(data.approvalThreshold) });
      setCapabilities(data.allowedCapabilities.join(", "));
    }
  }, [data]);

  if (error) return <p className="error">{error}</p>;
  if (!draft) return <p className="muted">Loading…</p>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const allowedCapabilities = capabilities.split(",").map((c) => c.trim()).filter(Boolean);
    if (await save.run(() => api.updatePolicy(orgId, { ...draft!, allowedCapabilities }))) reload();
  }

  return (
    <form className="card narrow stack" onSubmit={submit}>
      <h2>Request policy</h2>
      <p className="muted">
        Checked by the platform before every task grant. Decisions are deterministic and every denial is written to the audit log.
      </p>
      <label>
        Capabilities your agents may request (comma separated)
        <input disabled={!canEdit} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} />
      </label>
      <label>
        Maximum budget per task ({draft.currency})
        <input disabled={!canEdit} inputMode="decimal" value={draft.maxBudgetPerTask}
          onChange={(e) => setDraft({ ...draft, maxBudgetPerTask: e.target.value })} />
      </label>
      <label>
        Human approval required above ({draft.currency})
        <input disabled={!canEdit} inputMode="decimal" value={draft.approvalThreshold}
          onChange={(e) => setDraft({ ...draft, approvalThreshold: e.target.value })} />
      </label>
      <label>
        Currency
        <input disabled={!canEdit} maxLength={3} value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
      </label>
      <label>
        Grant requests per agent per minute
        <input disabled={!canEdit} type="number" min={1} max={10000} value={draft.rateLimitPerMinute}
          onChange={(e) => setDraft({ ...draft, rateLimitPerMinute: Number(e.target.value) })} />
      </label>
      <label className="row">
        <input disabled={!canEdit} type="checkbox" checked={draft.requireSeparateApprover === true}
          onChange={(e) => setDraft({ ...draft, requireSeparateApprover: e.target.checked })} />
        <span>
          Require a different person to approve commitments
          <span className="muted"> — whoever registered an agent cannot approve that agent's purchases</span>
        </span>
      </label>
      {save.error && <p className="error">{save.error}</p>}
      {canEdit ? <button disabled={save.busy}>Save policy</button> : <p className="muted">Only owners and admins can change the policy.</p>}
    </form>
  );
}
