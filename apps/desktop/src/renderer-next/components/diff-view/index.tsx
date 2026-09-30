import { parsePatch } from "diff";
import { useTranslation } from "react-i18next";
export const DiffView = ({
  patch,
  mode = "unified",
}: {
  patch: string;
  mode?: "unified" | "split";
}) => {
  const { t } = useTranslation();
  const parsed = parsePatch(patch);
  return (
    <div
      data-slot="diff-view"
      tabIndex={0}
      className="h-full overflow-auto font-mono text-xs leading-5"
      aria-label={t("sessions.changes.diff")}
    >
      {parsed.flatMap((file, fi) =>
        file.hunks.map((hunk, hi) => (
          <section key={`${fi}:${hi}`} id={`hunk-${fi}-${hi}`}>
            <div className="text-muted-foreground bg-muted px-4 py-2">{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</div>
            {hunk.lines.map((line, i) => {
              const added = line.startsWith("+");
              const removed = line.startsWith("-");
              return (
                <div
                  key={i}
                  className="flex min-w-max px-4"
                  style={
                    added
                      ? {
                          background: "var(--chat-diff-add-bg)",
                          color: "var(--chat-diff-add-fg)",
                        }
                      : removed
                        ? {
                            background: "var(--chat-diff-del-bg)",
                            color: "var(--chat-diff-del-fg)",
                          }
                        : undefined
                  }
                >
                  <span
                    aria-hidden
                    className="text-muted-foreground mr-4 inline-block w-8 text-right"
                  >
                    {i + 1}
                  </span>
                  <span className="sr-only">
                    {added
                      ? t("sessions.changes.added")
                      : removed
                        ? t("sessions.changes.removed")
                        : ""}
                  </span>
                  {mode === "split" ? (
                    <>
                      <pre className="w-1/2 whitespace-pre">
                        {added ? "" : line.slice(1)}
                      </pre>
                      <pre className="w-1/2 whitespace-pre">
                        {removed ? "" : line.slice(1)}
                      </pre>
                    </>
                  ) : (
                    <pre className="whitespace-pre">{line}</pre>
                  )}
                </div>
              );
            })}
          </section>
        ))
      )}
    </div>
  );
};
