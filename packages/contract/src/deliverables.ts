/**
 * What a tool handed over. A tool that produces a file declares it with an
 * `[artifact]` line in its result; `present_deliverable` declares each item
 * it accepted after checking the disk. Everything that shows a deliverable
 * reads those lines, so an item the tool turned away is shown nowhere.
 */

export const ARTIFACT_PATH_MARKER = "[artifact]";

/** How `present_deliverable` opens a result that handed over nothing: no path it named exists. */
export const NOTHING_PRESENTED = "Nothing could be presented";

/** The declaration line a tool result carries for one file or URL. */
export const artifactPathLine = (target: string): string =>
  `${ARTIFACT_PATH_MARKER} ${target}`;

/** A generated app is served on localhost, so a deliverable can be a URL. */
export const isDeliverableUrl = (value: string): boolean =>
  /^https?:\/\//i.test(value);

/** Every target a result declares, in order. */
export function declaredArtifactTargets(resultText: string): string[] {
  if (!resultText.includes(ARTIFACT_PATH_MARKER)) return [];
  const targets: string[] = [];
  for (const line of resultText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(ARTIFACT_PATH_MARKER)) continue;
    const target = trimmed.slice(ARTIFACT_PATH_MARKER.length).trim();
    if (target.length > 0) targets.push(target);
  }
  return targets;
}

/** One entry of `present_deliverable`'s ordered `items` argument. */
export interface DeliverableItem {
  path: string;
  label?: string;
}

/**
 * The tool's `items` argument, read defensively: it is streamed model output,
 * and one malformed entry must not take the transcript down. Order is kept.
 */
export function requestedDeliverables(
  input: Record<string, unknown>
): DeliverableItem[] {
  const raw = Array.isArray(input.items) ? input.items : [];
  const items: DeliverableItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry == null) continue;
    const record = entry as Record<string, unknown>;
    const path = String(record.path ?? "").trim();
    if (path.length === 0) continue;
    const label = String(record.label ?? "").trim();
    items.push(label.length > 0 ? { path, label } : { path });
  }
  return items;
}

export interface PresentedDeliverable {
  /** Absolute path or URL, as the tool declared it. */
  path: string;
  label?: string;
  isUrl: boolean;
}

/**
 * Does a declared target answer a requested path? The tool resolves a
 * relative path against the workspace, so the absolute form ends with it.
 * Separators do not count: the model is shown `C:/x` for the tool's `C:\x`.
 */
const answers = (declared: string, requested: string): boolean => {
  if (isDeliverableUrl(requested)) return declared === requested;
  const target = declared.replaceAll("\\", "/");
  const asked = requested.replaceAll("\\", "/");
  if (target === asked) return true;
  if (/^([a-zA-Z]:)?\//.test(asked)) return false;
  return target.endsWith(`/${asked.replace(/^\.\//, "")}`);
};

/**
 * The items a `present_deliverable` call handed over: what the tool declared,
 * in its order, labelled as the call named them. A refusal handed over
 * nothing. Any other result declaring nothing is from before the tool
 * declared anything, and the arguments are then all there is to go on.
 */
export function presentedDeliverables(
  input: Record<string, unknown>,
  resultText: string | undefined
): PresentedDeliverable[] {
  if (resultText?.startsWith(NOTHING_PRESENTED) === true) return [];
  const requested = requestedDeliverables(input);
  const declared = declaredArtifactTargets(resultText ?? "");

  if (declared.length === 0)
    return requested.map((item) => ({
      ...item,
      isUrl: isDeliverableUrl(item.path),
    }));

  return declared.map((path) => {
    const label = requested.find((item) => answers(path, item.path))?.label;
    return {
      path,
      ...(label != null ? { label } : {}),
      isUrl: isDeliverableUrl(path),
    };
  });
}
