import { CircleHelp, FastForward, ListChecks, ShieldCheck } from "lucide-react";
import { type ComponentType, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { AgentMode } from "#shared/agent-types";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "../ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

type ModeOption = {
  descriptionKey:
    | "workspace.runtimeMode.supervisedDescription"
    | "workspace.runtimeMode.acceptEditsDescription"
    | "workspace.runtimeMode.planDescription"
    | "workspace.runtimeMode.fullAccessDescription";
  icon: ComponentType<{ className?: string }>;
  labelKey:
    | "workspace.runtimeMode.supervised"
    | "workspace.runtimeMode.acceptEdits"
    | "workspace.runtimeMode.plan"
    | "workspace.runtimeMode.fullAccess";
  value: AgentMode;
};

const MODE_OPTIONS: ModeOption[] = [
  {
    value: AgentMode.Normal,
    labelKey: "workspace.runtimeMode.supervised",
    descriptionKey: "workspace.runtimeMode.supervisedDescription",
    icon: CircleHelp,
  },
  {
    value: AgentMode.AcceptEdits,
    labelKey: "workspace.runtimeMode.acceptEdits",
    descriptionKey: "workspace.runtimeMode.acceptEditsDescription",
    icon: FastForward,
  },
  {
    value: AgentMode.PlanMode,
    labelKey: "workspace.runtimeMode.plan",
    descriptionKey: "workspace.runtimeMode.planDescription",
    icon: ListChecks,
  },
  {
    value: AgentMode.Yolo,
    labelKey: "workspace.runtimeMode.fullAccess",
    descriptionKey: "workspace.runtimeMode.fullAccessDescription",
    icon: ShieldCheck,
  },
];

export const RuntimeModePicker = ({
  value,
  onChange,
  disabled = false,
}: {
  value: AgentMode;
  onChange: (value: AgentMode) => void;
  disabled?: boolean;
}): JSX.Element => {
  const { t } = useTranslation();
  const selected =
    MODE_OPTIONS.find((option) => option.value === value) ?? MODE_OPTIONS[0];
  const SelectedIcon = selected.icon;

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(nextValue) => {
        if (nextValue != null) onChange(nextValue as AgentMode);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              size="sm"
              data-id="local-code-mode-selector"
              aria-label={t(selected.labelKey)}
              className="hover:bg-muted/50 max-w-48 border-transparent bg-transparent"
            />
          }
        >
          <SelectedIcon />
          <span className="truncate">{t(selected.labelKey)}</span>
        </TooltipTrigger>
        <TooltipContent>{t(selected.descriptionKey)}</TooltipContent>
      </Tooltip>
      <SelectContent
        side="top"
        align="start"
        alignItemWithTrigger={false}
        className="min-w-64"
      >
        <SelectGroup>
          {MODE_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <SelectItem
                key={option.value}
                value={option.value}
                className="py-2"
              >
                <Icon />
                <span className="min-w-0 pe-5">
                  <span className="block font-medium">
                    {t(option.labelKey)}
                  </span>
                  <span className="text-muted-foreground block text-xs whitespace-normal">
                    {t(option.descriptionKey)}
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};
