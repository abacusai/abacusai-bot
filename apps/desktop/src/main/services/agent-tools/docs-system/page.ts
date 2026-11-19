/**
 * The sheet a document prints on, and the window it is laid out in: A4 with
 * margins and page numbers; a poster to the edge (body.bleed); a certificate
 * to the edge and turned sideways (body.bleed.landscape). Laid out at the
 * printed width (A4 less the margins, or the whole sheet).
 */
export const pageFor = (o: {
  bleed: boolean;
  landscape: boolean;
}): {
  print: { cssPageNumbers?: true; fullBleed?: true; landscape?: true };
  window: { width: number; height: number };
} =>
  !o.bleed
    ? { print: { cssPageNumbers: true }, window: { width: 650, height: 1123 } }
    : o.landscape
      ? {
          print: { fullBleed: true, landscape: true },
          window: { width: 1123, height: 794 },
        }
      : { print: { fullBleed: true }, window: { width: 794, height: 1123 } };
