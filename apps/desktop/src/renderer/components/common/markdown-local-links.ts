/**
 * The disk path behind a markdown link. A link's href is a URL reference in
 * every form the agent writes (`file://`, a bare path, a saved `abacusfile:`),
 * so percent-escapes are encoding, not part of the name.
 */

const LOCAL_FILE_SCHEME = "abacusfile:";

/** `file:///C:/x` slices to `/C:/x`; the leading slash is URL syntax there. */
const dropDriveSlash = (p: string): string =>
  /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;

/** A stray `%` in a real file name is not an escape; the href is kept as is. */
const percentDecoded = (value: string): string => {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Anything that is not a web URL, a protocol-relative link or a fragment. */
export const isLocalHref = (href: string): boolean =>
  href.startsWith("/") ||
  href.startsWith("./") ||
  href.startsWith("../") ||
  href.startsWith("~/") ||
  /^[A-Za-z]:[\\/]/.test(href) ||
  (!/^[a-z][a-z0-9+.-]*:/i.test(href) &&
    !href.startsWith("//") &&
    !href.startsWith("#"));

/** The disk path behind a re-badged (or plain `file://`) URL, else null. */
export const localPathFromUrl = (url: string): string | null => {
  if (url.startsWith("file://"))
    return dropDriveSlash(percentDecoded(url.slice("file://".length)));
  if (!url.startsWith(LOCAL_FILE_SCHEME)) return null;
  const rest = url.slice(LOCAL_FILE_SCHEME.length);
  return dropDriveSlash(
    percentDecoded(rest.startsWith("//") ? rest.slice(2) : rest)
  );
};

/** The disk path a link points at, in whichever form it was written, else null. */
export const localPathFromHref = (href: string): string | null =>
  localPathFromUrl(href) ?? (isLocalHref(href) ? percentDecoded(href) : null);
