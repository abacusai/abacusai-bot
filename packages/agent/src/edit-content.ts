/** Keep edit previews and file writes on the same BOM and line-ending rules. */
export function prepareEditContent(raw: string) {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const withoutBom = bom ? raw.slice(1) : raw;
  const crlf = withoutBom.includes("\r\n");
  const normalize = (text: string) =>
    crlf ? text.replaceAll("\r\n", "\n") : text;

  return {
    content: normalize(withoutBom),
    normalize,
    restore: (text: string) =>
      bom + (crlf ? text.replaceAll("\n", "\r\n") : text),
  };
}
