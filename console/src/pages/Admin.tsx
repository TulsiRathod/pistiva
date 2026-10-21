import type { Api } from "../api.ts";
import { useAction, useAsync } from "../useAsync.ts";

/** Platform-admin view: manual organization verification and suspension for abuse handling. */
export function Admin({ api }: { api: Api }) {
  const { data, error, reload } = useAsync(() => api.allOrgs(), [api]);
  const action = useAction();

  return (
    <section className="card">
      <h2>Organizations</h2>
      {(error || action.error) && <p className="error">{error ?? action.error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Domain</th>
              <th>Verification</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((o) => (
              <tr key={o.id}>
                <td>{o.name}</td>
                <td>{o.domain}</td>
                <td>
                  <span className={`badge ${o.verificationStatus === "VERIFIED" ? "ok" : "warn"}`}>{o.verificationStatus}</span>
                </td>
                <td>
                  <span className={`badge ${o.status === "ACTIVE" ? "ok" : "bad"}`}>{o.status}</span>
                </td>
                <td className="actions">
                  {o.verificationStatus !== "VERIFIED" && (
                    <button className="small" disabled={action.busy} onClick={() => action.run(() => api.verifyOrg(o.id, "manual")).then(reload)}>
                      Verify
                    </button>
                  )}
                  <button
                    className={`small ${o.status === "ACTIVE" ? "danger" : ""}`}
                    disabled={action.busy}
                    onClick={() => action.run(() => api.setOrgStatus(o.id, o.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")).then(reload)}
                  >
                    {o.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
