import { NOTCH_SPACING as spacing } from "@abacus-ai/contract/contract/notch-spacing";

/** A silhouette centered in the fixed transparent envelope.
 * Hardware shoulders meet the bezel; floating capsules use four convex corners.
 * CSS path clipping also makes Chromium hit-testing follow the painted shell.
 */
export const shellClip = (
  width: number,
  height: number,
  envelopeWidth: number,
  hardware = true
): string => {
  const w = Math.max(0, Math.min(envelopeWidth, width));
  const h = Math.max(0, height);
  const x = (envelopeWidth - w) / 2;
  const r = x + w;
  if (!hardware) {
    const radius = Math.min(spacing.capsuleRadius, w / 2, h / 2);
    return `path("M ${x + radius} 0 H ${r - radius} Q ${r} 0 ${r} ${radius} V ${h - radius} Q ${r} ${h} ${r - radius} ${h} H ${x + radius} Q ${x} ${h} ${x} ${h - radius} V ${radius} Q ${x} 0 ${x + radius} 0 Z")`;
  }
  const shoulder = Math.min(spacing.shoulder, w / 4, h / 3);
  const bottom = Math.min(
    spacing.bottomRadius,
    (w - 2 * shoulder) / 2,
    h - shoulder
  );
  const left = x + shoulder;
  const right = r - shoulder;
  return `path("M ${x} 0 H ${r} C ${right} 0 ${right} 0 ${right} ${shoulder} V ${h - bottom} Q ${right} ${h} ${right - bottom} ${h} H ${left + bottom} Q ${left} ${h} ${left} ${h - bottom} V ${shoulder} C ${left} 0 ${left} 0 ${x} 0 Z")`;
};
