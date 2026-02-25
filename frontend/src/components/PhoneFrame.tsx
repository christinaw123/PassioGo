import type { ReactNode } from "react";

/** Wraps the app in a phone mockup on desktop (≥ 600 px wide).
 *  On narrow viewports (real mobile) all frame elements are hidden and
 *  the content fills the screen normally. */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="phone-shell">
      {/* ── Left side buttons ────────────────────────────── */}
      <div className="phone-btn phone-btn-silent" />
      <div className="phone-btn phone-btn-vol-up" />
      <div className="phone-btn phone-btn-vol-dn" />
      {/* ── Right side button ────────────────────────────── */}
      <div className="phone-btn phone-btn-power" />

      {/* ── Screen area ──────────────────────────────────── */}
      <div className="phone-screen">
        {/* Dynamic Island */}
        <div className="phone-island" />

        {/* App content */}
        <div className="phone-content">{children}</div>

        {/* Home indicator */}
        <div className="phone-home-bar" />
      </div>
    </div>
  );
}
