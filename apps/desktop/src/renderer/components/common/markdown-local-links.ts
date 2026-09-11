/** Keeps file links clickable; saved messages may still carry `abacusfile:`. */

const LOCAL_FILE_SCHEME = "abacusfile:";

/** `file:///C:/x` slices to `/C:/x`; the leading slash is URL syntax there. */
const dropDriveSlash = (p: string): string =>
  /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;

/** The disk path behind a re-badged (or plain `file://`) URL, else null. */
export const localPathFromUrl = (url: string): string | null => {
  if (url.startsWith("file://"))
    return dropDriveSlash(decodeURIComponent(url.slice("file://".length)));
  if (!url.startsWith(LOCAL_FILE_SCHEME)) return null;
  const rest = url.slice(LOCAL_FILE_SCHEME.length);
  return dropDriveSlash(
    decodeURIComponent(rest.startsWith("//") ? rest.slice(2) : rest)
  );
};
