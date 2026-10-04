/**
 * Which procedures a connection may call, for transports that serve someone
 * other than the desktop's own windows: a browser tab of the hosted web app,
 * or the web app reaching this desktop for coding. An allowlist, so a
 * procedure added to the contract later is refused until someone decides.
 */
import { forbidden } from "./errors";

/**
 * Dotted procedure paths. A `*` segment matches any one segment; as the last
 * segment it matches everything beneath (`ai.*` covers `ai.queue.update`).
 */
export type ProcedurePatterns = readonly string[];

const matchesPattern = (pattern: string, path: readonly string[]): boolean => {
  const segments = pattern.split(".");
  const last = segments.length - 1;
  if (segments[last] === "*") {
    if (path.length <= last) return false;
  } else if (path.length !== segments.length) {
    return false;
  }
  return segments.every(
    (segment, index) => segment === "*" || segment === path[index]
  );
};

export const matchesProcedure = (
  patterns: ProcedurePatterns,
  path: readonly string[]
): boolean => patterns.some((pattern) => matchesPattern(pattern, path));

/** A client interceptor refusing every procedure the patterns do not name. */
export const procedurePolicyInterceptor =
  (patterns: ProcedurePatterns) =>
  ({
    next,
    path,
  }: {
    next: () => Promise<unknown>;
    path: readonly string[];
  }): Promise<unknown> => {
    if (!matchesProcedure(patterns, path))
      throw forbidden(
        "not-available-here",
        `${path.join(".")} is not available here`
      );
    return next();
  };
