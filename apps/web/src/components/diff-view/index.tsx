import { parsePatch } from "diff";
import { useTranslation } from "react-i18next";
export const diffRows = (patch: string) =>
  parsePatch(patch).flatMap((file, fi) =>
    file.hunks.map((hunk, hi) => {
      let old = hunk.oldStart;
      let next = hunk.newStart;
      return {
        id: `hunk-${fi}-${hi}`,
        header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        lines: hunk.lines.map((line) => {
          const kind =
            line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "context";
          return {
            text: line,
            kind,
            old: kind === "added" ? null : old++,
            next: kind === "removed" ? null : next++,
          };
        }),
      };
    })
  );
export const DiffView = ({
  patch,
  mode = "unified",
}: {
  patch: string;
  mode?: "unified" | "split";
}) => {
  const { t } = useTranslation();
  return (
    <div
      data-slot="diff-view"
      tabIndex={0}
      className="h-full w-full overflow-auto font-mono text-[length:var(--code-font-size,12px)] leading-5"
      aria-label={t("sessions.changes.diff")}
    >
      {diffRows(patch).map((hunk) => (
        <section key={hunk.id} id={hunk.id}>
          <div className="text-muted-foreground bg-muted px-4 py-2">
            {hunk.header}
          </div>
          {hunk.lines.map((line, i) => (
            <div
              key={i}
              className="flex min-w-max px-4"
              style={
                line.kind === "context"
                  ? undefined
                  : {
                      background: `var(--chat-diff-${line.kind === "added" ? "add" : "del"}-bg)`,
                      color: `var(--chat-diff-${line.kind === "added" ? "add" : "del"}-fg)`,
                    }
              }
            >
              <span
                aria-hidden
                className="text-muted-foreground mr-2 inline-block w-8 text-right"
              >
                {line.old}
              </span>
              <span
                aria-hidden
                className="text-muted-foreground mr-4 inline-block w-8 text-right"
              >
                {line.next}
              </span>
              <span className="sr-only">
                {line.kind === "context"
                  ? ""
                  : t(`sessions.changes.${line.kind}`)}
              </span>
              {mode === "split" ? (
                <>
                  <pre className="w-1/2 whitespace-pre">
                    {line.kind === "added" ? "" : line.text.slice(1)}
                  </pre>
                  <pre className="w-1/2 whitespace-pre">
                    {line.kind === "removed" ? "" : line.text.slice(1)}
                  </pre>
                </>
              ) : (
                <pre className="whitespace-pre">{line.text}</pre>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
};
