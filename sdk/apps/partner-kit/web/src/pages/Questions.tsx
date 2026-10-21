import { useEffect, useState } from "react";
import type { NodeApi, Question } from "../api.ts";
import { relative } from "../App.tsx";
import { useAction, useAsync } from "../useAsync.ts";

export function Questions({ api }: { api: NodeApi }) {
  const open = useAsync(() => api.questions("open"), [api]);
  const history = useAsync(() => api.questions("all"), [api]);
  useEffect(() => {
    const t = setInterval(open.reload, 3000);
    return () => clearInterval(t);
  }, [open.reload]);
  const reload = () => {
    open.reload();
    history.reload();
  };

  return (
    <>
      {open.data?.length === 0 && (
        <section className="card empty">
          <h3>Nothing waiting</h3>
          <p className="muted">When a supplier needs more information before quoting, the question appears here.</p>
        </section>
      )}
      {open.data?.map((q) => <QuestionCard key={q.id} api={api} q={q} onDone={reload} />)}

      <section className="card">
        <h2>Answered</h2>
        <ul className="feed">
          {history.data
            ?.filter((q) => q.status !== "open")
            .map((q) => (
              <li key={q.id}>
                <span className={`chip ${q.status === "answered" ? "chip-green" : "chip-warn"}`}>{q.status}</span>
                <span className="feed-main">
                  {q.peerName}: {q.question.question} {q.answer && <strong>→ {q.answer}</strong>}
                </span>
                <span className="muted feed-time">{relative(q.createdAt)}</span>
              </li>
            ))}
        </ul>
      </section>
    </>
  );
}

function QuestionCard({ api, q, onDone }: { api: NodeApi; q: Question; onDone: () => void }) {
  const [custom, setCustom] = useState("");
  const action = useAction();
  const answer = (a: string | null) => action.run(() => api.answer(q.id, a)).then((ok) => ok && onDone());

  return (
    <section className="card question">
      <div className="row">
        <span className="chip chip-warn">needs your answer</span>
        <span className="muted">
          {q.peerName} · <code>{q.capability}</code> · round {q.round} · {relative(q.createdAt)}
        </span>
      </div>
      <h3 className="question-text">{q.question.question}</h3>
      <div className="row">
        {q.question.options?.map((o) => (
          <button key={o} disabled={action.busy} onClick={() => answer(o)}>
            {o}
          </button>
        ))}
        <input className="grow" placeholder="Or type an answer" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button className="btn-outline btn" disabled={action.busy || !custom.trim()} onClick={() => answer(custom.trim())}>
          Send
        </button>
        <button className="link" disabled={action.busy} onClick={() => answer(null)}>
          Decline &amp; cancel task
        </button>
      </div>
      {action.error && <p className="error">{action.error}</p>}
    </section>
  );
}
