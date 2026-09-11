import type { JSX } from "react";

/**
 * The mark, as a face: {@link AbacusBotMark}'s geometry recomposed so it reads
 * as something looking back. Idle is completely still: anything that moves
 * while the agent does nothing gets ignored, so the signal is still versus
 * moving, not two speeds. Bars and eyes are `currentColor`; beads keep their
 * brand colours. Sized for 18–28px, hence large eyes and low-opacity columns:
 * at 18px an eye drawn to the logo's proportions is a single dot.
 */
export type AbacusBotMascotState = "idle" | "thinking" | "busy";

export const AbacusBotMascot = ({
  size = 28,
  state = "idle",
  className = "",
  dataId = "abacus-bot-mascot",
}: {
  size?: number;
  state?: AbacusBotMascotState;
  className?: string;
  dataId?: string;
}): JSX.Element => {
  const moving = state !== "idle";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 400 400"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      data-id={dataId}
      data-state={state}
      className={`shrink-0 ${className}`}
    >
      {/* The columns, receded — scenery for the face rather than the subject. */}
      <g fill="currentColor" opacity="0.16">
        <rect x="70" y="88" width="36" height="96" rx="18" />
        <rect x="70" y="272" width="36" height="60" rx="18" />
        <rect x="149" y="45" width="36" height="72" rx="18" />
        <rect x="228" y="40" width="36" height="152" rx="18" />
        <rect x="307" y="88" width="36" height="64" rx="18" />
        <rect x="307" y="245" width="36" height="87" rx="18" />
      </g>

      {/* Beads, off their rods and circling. The group rotates about the centre;
          each bead keeps its own colour and position on the ring. */}
      <g
        className={
          moving
            ? `abacus-mascot-orbit abacus-mascot-orbit--${state}`
            : undefined
        }
      >
        <circle cx="200" cy="70" r="24" fill="#2A82E8" />
        <circle cx="330" cy="200" r="24" fill="#D62D97" />
        <circle cx="200" cy="330" r="24" fill="#2EE6D6" />
        <circle cx="70" cy="200" r="24" fill="#A233FB" />
      </g>

      {/* Eyes. They scale on the y axis to blink, so the origin is the centre of
          the face rather than the top-left of the canvas. */}
      <g
        fill="currentColor"
        className={moving ? "abacus-mascot-blink" : undefined}
      >
        <circle cx="163" cy="200" r="36" />
        <circle cx="250" cy="200" r="36" />
      </g>
    </svg>
  );
};
