import type { Transport } from "#renderer/data/transport";
import { foldSearch, rpcError } from "#renderer/lib/use-app-context";
import type {
  ArtifactRow,
  SessionRow,
  RoutineRow,
  BotRow,
  WorkspaceRow,
} from "#shared/contract/rows";
export interface ArtifactSource {
  botIds: string[];
  routine: string | null;
  workspaceId: string;
  label: string;
  sessionLabel: string;
  session?: SessionRow;
}
export const sourceFor = (
  artifact: ArtifactRow,
  sessions: readonly SessionRow[],
  routines: readonly RoutineRow[],
  bots: readonly BotRow[],
  workspaces: readonly WorkspaceRow[]
): ArtifactSource => {
  const session = sessions.find((s) => s.id === artifact.sessionId);
  const routine = routines.find((r) => r.id === session?.routineId);
  const ids = new Set<string>();
  if (session?.owner?.botId) ids.add(session.owner.botId);
  if (routine?.botId) ids.add(routine.botId);
  const label = session?.owner
    ? (bots.find((b) => b.id === session.owner?.botId)?.name ?? session.label)
    : (routine?.name ??
      session?.label ??
      workspaces.find((w) => w.id === artifact.workspaceId)?.label ??
      "");
  return {
    botIds: [...ids],
    routine: session?.routineId ?? null,
    workspaceId: artifact.workspaceId,
    label: label ?? "",
    sessionLabel: session?.label ?? "",
    ...(session ? { session } : {}),
  };
};
export interface ArtifactFilter {
  q?: string;
  type?: string;
  from?: string;
  sort?: string;
}
export const filterArtifacts = (
  rows: readonly ArtifactRow[],
  sources: ReadonlyMap<string, ArtifactSource>,
  search: ArtifactFilter
): ArtifactRow[] =>
  rows
    .filter((a) => {
      const s = sources.get(a.id);
      if (search.type && a.kind !== search.type) return false;
      if (search.from === "routines" && s?.routine == null) return false;
      if (
        search.from?.startsWith("bot:") &&
        !s?.botIds.includes(search.from.slice(4))
      )
        return false;
      if (
        search.from?.startsWith("workspace:") &&
        a.workspaceId !== search.from.slice(10)
      )
        return false;
      return (
        !search.q ||
        foldSearch(
          [a.title, a.location, s?.sessionLabel, s?.label].join(" ")
        ).includes(foldSearch(search.q))
      );
    })
    .toSorted((a, b) =>
      search.sort === "name"
        ? a.title.localeCompare(b.title, undefined, { numeric: true })
        : search.sort === "oldest"
          ? a.updatedAt.localeCompare(b.updatedAt)
          : b.updatedAt.localeCompare(a.updatedAt)
    );
export const dirname = (path: string): string => {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path.slice(0, 1) : path.slice(0, index);
};
export const formatForArtifact = (
  a: Pick<ArtifactRow, "kind" | "location">
): string => {
  if (a.kind === "link") return "web";
  if (a.kind === "image") return "image";
  const extension = a.location.split(".").at(-1)?.toLowerCase();
  const formats: Record<string, string> = {
    pdf: "pdf",
    doc: "word",
    docx: "word",
    xls: "spreadsheet",
    xlsx: "spreadsheet",
    csv: "spreadsheet",
    pptx: "slides",
    md: "markdown",
    txt: "text",
    zip: "archive",
    tar: "archive",
    gz: "archive",
    mp3: "audio",
    wav: "audio",
    mp4: "video",
    mov: "video",
  };
  return formats[extension ?? ""] ?? "code";
};
export const openArtifact = async (
  transport: Pick<Transport, "client">,
  a: ArtifactRow
): Promise<"opened" | "missing" | "directory" | "revealed" | "refused"> => {
  if (a.kind === "link") {
    await transport.client.system.openExternal({ url: a.location });
    return "opened";
  }
  try {
    await transport.client.files.readText({
      filePath: a.location,
      hostRoot: dirname(a.location),
      maxBytes: 1,
    });
  } catch (e) {
    const typed = rpcError(e);
    if (typed?.code === "NOT_FOUND") return "missing";
    if (typed?.code === "CONFLICT" && typed.data.reason === "not-a-file") {
      await transport.client.system.showItemInFolder({ path: a.location });
      return "directory";
    }
    if (typed?.code !== "FORBIDDEN" && typed?.code !== "CONFLICT") throw e;
  }
  const result = await transport.client.system.openPath({ path: a.location });
  return result.outcome === "refused" && result.reason === "missing"
    ? "missing"
    : result.outcome;
};
export const artifactTarget = (
  source: ArtifactSource,
  sessionId: string
): {
  to: string;
  params: Record<string, string>;
  search?: Record<string, string>;
} | null => {
  const s = source.session;
  if (!s) return null;
  if (s.routineId)
    return {
      to: "/routines/$routineId",
      params: { routineId: s.routineId },
      search: { run: sessionId },
    };
  if (s.owner)
    return s.owner.role === "forever"
      ? { to: "/bots/$botId", params: { botId: s.owner.botId } }
      : {
          to: "/bots/$botId/chats/$sessionId",
          params: { botId: s.owner.botId, sessionId },
        };
  return { to: "/sessions/$sessionId", params: { sessionId } };
};
export const MAX_MOUNTED = 400;
export const cardWindow = (
  length: number,
  scrollTop: number,
  columns: number,
  height: number,
  viewportHeight = 800
) => {
  const perRow = Math.min(MAX_MOUNTED, Math.max(1, columns));
  const rows = Math.ceil(viewportHeight / height) + 8;
  const budget = Math.min(rows, Math.floor(MAX_MOUNTED / perRow)) * perRow;
  const start = Math.min(
    Math.ceil(Math.max(0, length - budget) / perRow) * perRow,
    Math.max(0, Math.floor(scrollTop / height) - 4) * perRow
  );
  const end = Math.min(length, start + budget);
  return {
    start,
    end,
    before: Math.floor(start / perRow) * height,
    after: Math.ceil((length - end) / perRow) * height,
  };
};

/** Local calendar dates, including daylight-saving boundaries. */
export const artifactDay = (date: string): string => {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
};
export type ArtifactListEntry =
  | { artifact: ArtifactRow }
  | { day: string; date: string };
export const artifactListEntries = (
  rows: readonly ArtifactRow[],
  grouped: boolean
): ArtifactListEntry[] => {
  let previous: string | undefined;
  return rows.flatMap((artifact) => {
    const day = artifactDay(artifact.updatedAt);
    const heading =
      grouped && day !== previous ? [{ day, date: artifact.updatedAt }] : [];
    previous = day;
    return [...heading, { artifact }];
  });
};
