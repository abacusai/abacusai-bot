import type { JSX } from "react";

import appIcon from "../../assets/icon2.png";

/**
 * The AbacusAI Bot mark. SVG rather than a bitmap: crisp at any DPI, and the
 * tile keeps its own dark background so the mark reads identically in both
 * themes; only the wordmark follows the theme.
 */
export const AbacusBotMark = ({
  size = 20,
  className = "",
}: {
  size?: number;
  className?: string;
}): JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 400 400"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className={`shrink-0 ${className}`}
  >
    <rect width="400" height="400" rx="48" fill="#0E1225" />

    {/* Column 1 */}
    <rect x="70" y="88" width="36" height="96" rx="18" fill="#FFFFFF" />
    <circle cx="88" cy="225" r="27" fill="#2A82E8" />
    <rect x="70" y="272" width="36" height="60" rx="18" fill="#D6E1F5" />

    {/* Column 2 */}
    <rect x="149" y="45" width="36" height="72" rx="18" fill="#D6E1F5" />
    <circle cx="167" cy="156" r="28" fill="#D62D97" />
    <rect x="149" y="203" width="36" height="152" rx="18" fill="#FFFFFF" />

    {/* Column 3 */}
    <rect x="228" y="40" width="36" height="152" rx="18" fill="#FFFFFF" />
    <circle cx="246" cy="248" r="28" fill="#2EE6D6" />
    <rect x="228" y="290" width="36" height="65" rx="18" fill="#D6E1F5" />

    {/* Column 4 */}
    <rect x="307" y="88" width="36" height="64" rx="18" fill="#D6E1F5" />
    <circle cx="325" cy="200" r="28" fill="#A233FB" />
    <rect x="307" y="245" width="36" height="87" rx="18" fill="#FFFFFF" />
  </svg>
);

/**
 * The app's own icon, as it appears in the dock and the taskbar. The titlebar
 * wears this rather than the Abacus mark above: the window should be
 * recognisable as the same thing the user clicked to open it.
 */
export const AppIconMark = ({
  size = 20,
  className = "",
}: {
  size?: number;
  className?: string;
}): JSX.Element => (
  <img
    src={appIcon}
    alt=""
    width={size}
    height={size}
    className={`shrink-0 rounded-[22%] ${className}`}
  />
);

export const AbacusBotLogo = ({
  className = "",
  dataId = "abacusai-bot-logo",
  markOnly = false,
  size = 20,
}: {
  className?: string;
  dataId?: string;
  markOnly?: boolean;
  size?: number;
}): JSX.Element => (
  <div
    className={`flex items-center gap-2 select-none ${className}`}
    data-id={dataId}
  >
    <AppIconMark size={size} />
    {markOnly ? null : (
      <span className="text-foreground text-sm font-semibold tracking-tight whitespace-nowrap">
        {/* brand wordmark: not translated */}
        Abacus
        <span className="text-secondary-foreground font-normal">
          {" "}
          AI Bot
        </span>{" "}
        {/* i18n-ignore */}
      </span>
    )}
  </div>
);
