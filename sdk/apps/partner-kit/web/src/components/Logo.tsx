/**
 * The Pistiva mark: an upper leaf over a lower leaf, forming a "P". The shapes are the original logo; the
 * colours come from theme tokens so the lower leaf stays visible on both the dark and the light palette.
 * Render <LogoSprite /> once near the root, then use <LogoMark /> anywhere.
 */
export function LogoSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden focusable="false">
      <defs>
        <linearGradient id="pv-top" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "var(--logo-top-a)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-top-b)" }} />
        </linearGradient>
        <linearGradient id="pv-bottom" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" style={{ stopColor: "var(--logo-bot-a)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-bot-b)" }} />
        </linearGradient>
        <symbol id="pistiva-logo" viewBox="0 0 275 297">
          <path fill="url(#pv-top)" d="M0 112C0 50 50 0 112 0H249Q275 0 275 26V40C275 87 231 131 174 131H72C32 131 0 163 0 200Z" />
          <path fill="url(#pv-bottom)" d="M72 131H132V196C132 254 86 297 22 297Q0 297 0 279V200C0 162 32 131 72 131Z" />
        </symbol>
      </defs>
    </svg>
  );
}

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo" width={Math.round(size * (275 / 297))} height={size} aria-hidden>
      <use href="#pistiva-logo" />
    </svg>
  );
}
