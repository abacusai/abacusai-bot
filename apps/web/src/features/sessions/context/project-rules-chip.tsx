import { ScrollText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";

const fileName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path;

/**
 * The AGENTS.md / CLAUDE.md files the agent follows in this chat, named in
 * the context tray. Nothing when it reads none. One file opens on click;
 * several (a project's and the home folder's) are listed first.
 */
export const ProjectRulesChip = ({
  files,
  onOpen,
}: {
  files: readonly string[];
  onOpen?: (path: string) => void;
}) => {
  const { t } = useTranslation();
  if (files.length === 0) return null;
  const names = files.map(fileName).join(", ");
  const label = t("sessions.tray.rulesLabel", { files: names });
  const content = (
    <>
      <ScrollText />
      <span className="max-w-56 truncate">
        {t("sessions.tray.rulesChip", { files: names })}
      </span>
    </>
  );
  if (files.length === 1)
    return (
      <Button
        variant="ghost"
        size="sm"
        data-slot="project-rules-chip"
        aria-label={label}
        title={`${label}\n${files[0]}`}
        className="text-muted-foreground"
        disabled={onOpen == null}
        onClick={() => onOpen?.(files[0]!)}
      >
        {content}
      </Button>
    );
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-slot="project-rules-chip"
            aria-label={label}
            title={label}
            className="text-muted-foreground"
          />
        }
      >
        {content}
      </PopoverTrigger>
      <PopoverContent className="w-[min(380px,var(--available-width))] gap-1 rounded-[14px] p-1.5">
        <p className="text-muted-foreground px-2 py-1 text-xs">
          {t("sessions.tray.rules")}
        </p>
        {files.map((file) => (
          <Button
            key={file}
            variant="ghost"
            className="h-auto w-full flex-col items-start gap-0 rounded-lg px-2 py-1.5"
            disabled={onOpen == null}
            onClick={() => onOpen?.(file)}
          >
            <span className="text-[13px]">{fileName(file)}</span>
            <span className="text-muted-foreground w-full truncate text-left font-mono text-[11px]">
              {file}
            </span>
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
};
