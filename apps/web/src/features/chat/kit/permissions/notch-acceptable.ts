import type { PermissionDescriptor } from "../../store/thread-store";
export type FitMeasure = (lines: readonly string[]) => boolean;
export const notchAcceptable = (
  descriptor: PermissionDescriptor,
  measure: FitMeasure
):
  | { ok: true; lines: string[] }
  | { ok: false; reason: "review" | "overflow" } => {
  const r = descriptor.metadata.abacus.request;
  let lines: string[];
  switch (r.type) {
    case "run_terminal":
      if (r.credentialPaths?.length || r.unmatchedPatterns?.length)
        return { ok: false, reason: "review" };
      lines = [
        r.command,
        r.cwd,
        ...(r.background ? ["in the background"] : []),
      ];
      break;
    case "delete":
      lines = [r.filePath];
      break;
    case "read_outside_directory":
      lines = [r.resolvedPath];
      break;
    case "fetch_url":
      lines = [r.url];
      break;
    case "network_host":
      lines = [`${r.host}:${r.port}`];
      break;
    case "sandbox_denied":
      if (r.denials.length > 2) return { ok: false, reason: "review" };
      lines = [
        r.command,
        ...r.denials.map((d) =>
          d.kind === "host" ? `${d.host}:${d.port}` : `${d.kind}: ${d.path}`
        ),
        ...(r.note ? [r.note] : []),
      ];
      break;
    case "browser_action":
      lines = [r.action, ...(r.url ? [r.url] : []), r.description];
      break;
    default:
      return { ok: false, reason: "review" };
  }
  return measure(lines)
    ? { ok: true, lines }
    : { ok: false, reason: "overflow" };
};
