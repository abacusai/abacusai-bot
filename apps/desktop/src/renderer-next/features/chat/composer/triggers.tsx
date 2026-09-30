/**
 * The composer's `@` (file mentions, sessions) and `/` (skills, at the
 * start of the field) menus (spec 02 §8.4). The menu owns the keyboard
 * while open: arrows move, Enter/Tab pick, Escape closes.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#next/lib/cn";

import type { MentionSource } from "../kit/context";
import type { SkillMetadata } from "../store/thread-store";

export interface TriggerState {
  kind: "mention" | "skill";
  query: string;
  /** The token's range in the text, replaced on pick. */
  start: number;
  end: number;
}

export const triggerAt = (
  text: string,
  caret: number,
  enabled: { mentions: boolean; skills: boolean }
): TriggerState | null => {
  const before = text.slice(0, caret);
  if (enabled.skills) {
    const skill = /^\/([\w-]*)$/.exec(before);
    if (skill != null)
      return { kind: "skill", query: skill[1]!, start: 0, end: caret };
  }
  if (enabled.mentions) {
    const mention = /(^|\s)@([\w./-]*)$/.exec(before);
    if (mention != null)
      return {
        kind: "mention",
        query: mention[2]!,
        start: caret - mention[2]!.length - 1,
        end: caret,
      };
  }
  return null;
};

export const TriggerMenu = ({
  trigger,
  skills,
  mentions,
  onPick,
  onClose,
}: {
  trigger: TriggerState;
  skills: readonly SkillMetadata[];
  mentions: MentionSource | undefined;
  onPick(insert: string): void;
  onClose(): void;
}) => {
  const { t } = useTranslation();
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (trigger.kind !== "mention" || mentions == null) return;
    let live = true;
    mentions
      .search(trigger.query)
      .then((found) => live && setFiles(found.slice(0, 8)))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [trigger.kind, trigger.query, mentions]);
  const options =
    trigger.kind === "skill"
      ? skills
          .filter((skill) =>
            skill.name.toLowerCase().includes(trigger.query.toLowerCase())
          )
          .slice(0, 8)
          .map((skill) => ({
            id: skill.id,
            label: `/${skill.name}`,
            hint: skill.description,
            insert: `/${skill.name} `,
          }))
      : files.map((path) => ({
          id: path,
          label: path,
          hint: "",
          insert: `@${path} `,
        }));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (options.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive(
          (index) =>
            (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) %
            options.length
        );
      } else if (
        (event.key === "Enter" || event.key === "Tab") &&
        !(event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onPick(options[Math.min(active, options.length - 1)]!.insert);
      } else if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [options, active, onPick, onClose]);
  if (options.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label={
        trigger.kind === "skill"
          ? t("chat.composer.skills")
          : t("chat.composer.files")
      }
      className={cn(
        "mb-1.5 flex flex-col rounded-[14px] bg-[var(--chat-surface)] p-1.5",
        trigger.kind === "mention" && "chat-mono text-xs"
      )}
    >
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="option"
          aria-selected={index === active}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(option.insert)}
          className={cn(
            "flex h-8 items-center gap-2 rounded-lg px-2.5 text-start",
            index === active && "bg-secondary"
          )}
        >
          <span className="truncate">{option.label}</span>
          {option.hint !== "" ? (
            <span className="text-muted-foreground truncate text-xs">
              {option.hint}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
};
