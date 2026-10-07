/** A top-attached silhouette, centered in the fixed transparent envelope.
 * The inward shoulders meet the screen edge; the bottom corners stay round.
 * CSS path clipping also makes Chromium hit-testing follow the painted shell.
 */
export const shellClip = (
  width: number,
  height: number,
  envelopeWidth: number
): string => {
  const w = Math.max(0, Math.min(envelopeWidth, width));
  const h = Math.max(0, height);
  const x = (envelopeWidth - w) / 2;
  const r = x + w;
  const shoulder = Math.min(12, w / 4, h / 3);
  const bottom = Math.min(20, (w - 2 * shoulder) / 2, h - shoulder);
  const left = x + shoulder;
  const right = r - shoulder;
  return `path("M ${x} 0 H ${r} C ${right} 0 ${right} 0 ${right} ${shoulder} V ${h - bottom} Q ${right} ${h} ${right - bottom} ${h} H ${left + bottom} Q ${left} ${h} ${left} ${h - bottom} V ${shoulder} C ${left} 0 ${left} 0 ${x} 0 Z")`;
};
