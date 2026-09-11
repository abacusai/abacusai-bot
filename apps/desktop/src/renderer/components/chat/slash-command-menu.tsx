import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef } from "react";

import type { SkillMetadata } from "#shared/agent-types";

import { filterSkills } from "../../utils/skill-utils";
import { Button } from "../ui";

interface SlashCommandMenuProps {
  skills: SkillMetadata[];
  query: string;
  selectedIndex: number;
  onSelect: (skill: SkillMetadata) => void;
  visible: boolean;
}

export const SlashCommandMenu = ({
  skills,
  query,
  selectedIndex,
  onSelect,
  visible,
}: SlashCommandMenuProps) => {
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = filterSkills(skills, query);

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!visible || filtered.length === 0) return null;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={listRef}
          role="listbox"
          className="bg-popover text-popover-foreground ring-foreground/10 absolute right-0 bottom-full left-0 z-50 mb-1 max-h-52 overflow-y-auto rounded-lg p-1 shadow-md ring-1"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.15 }}
        >
          {filtered.map((skill, i) => (
            <Button
              variant="ghost"
              size="sm"
              key={skill.id}
              role="option"
              aria-selected={i === selectedIndex}
              className={`h-auto min-h-7 w-full cursor-default justify-start px-2 py-1.5 text-left whitespace-normal ${
                i === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent hover:text-accent-foreground"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(skill);
              }}
            >
              <span className="shrink-0 font-medium">/{skill.id}</span>
              <span className="text-muted-foreground min-w-0 truncate">
                {skill.description}
              </span>
            </Button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
