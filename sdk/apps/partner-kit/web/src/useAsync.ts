import { useCallback, useEffect, useState } from "react";

/** Loads data on mount and whenever deps change; `reload` re-runs it after a mutation. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  // The caller's deps decide when `load` is stale, as with useEffect.
  const run = useCallback(load, deps);

  const reload = useCallback(() => {
    setLoading(true);
    run()
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [run]);

  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

/** Wraps a mutation so the page can show its error without try/catch at every call site. */
export function useAction() {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, error, busy };
}
