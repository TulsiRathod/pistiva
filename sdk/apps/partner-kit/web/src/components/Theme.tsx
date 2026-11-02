import { useState } from "react";

const KEY = "pistiva.theme";
type Theme = "dark" | "light";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

function effective(): Theme {
  return (document.documentElement.getAttribute("data-theme") as Theme | null) ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}

/** Applies the viewer's saved choice, if any. Without one the system setting decides. */
export function initTheme(): void {
  const t = stored();
  if (t) document.documentElement.setAttribute("data-theme", t);
}

export function ThemeToggle({ className = "icon-btn" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(effective);
  function flip() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice lasts for this visit */
    }
    setTheme(next);
  }
  return (
    <button type="button" className={className} onClick={flip} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Switch colour theme">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
        {theme === "dark" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" />
        )}
      </svg>
    </button>
  );
}
