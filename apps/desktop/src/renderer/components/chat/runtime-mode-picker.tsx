import {
  CircleHelp,
  FastForward,
  ListChecks,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { type ComponentType, type JSX, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { AgentMode } from "#shared/agent-types";

import { useSandboxSupportQuery } from "../../hooks/use-sandbox";
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
    | "workspace.runtimeMode.autoDescription"
    | "workspace.runtimeMode.fullAccessDescription";
  icon: ComponentType<{ className?: string }>;
  labelKey:
    | "workspace.runtimeMode.supervised"
    | "workspace.runtimeMode.acceptEdits"
    | "workspace.runtimeMode.plan"
    | "workspace.runtimeMode.auto"
    | "workspace.runtimeMode.fullAccess";
  value: AgentMode;
};

// Auto leads: it is the mode to reach for, and the one the Profile page
// offers as the default beside Full access.
const MODE_OPTIONS: ModeOption[] = [
  {
    value: AgentMode.Auto,
    labelKey: "workspace.runtimeMode.auto",
    descriptionKey: "workspace.runtimeMode.autoDescription",
    icon: ShieldCheck,
  },
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
    icon: ShieldOff,
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
  // Auto is only offered where the sandbox works: without one it would be
  // Full access under a safer name.
  const sandbox = useSandboxSupportQuery().data;
  const options = useMemo(
    () =>
      sandbox?.available === true
        ? MODE_OPTIONS
        : MODE_OPTIONS.filter((option) => option.value !== AgentMode.Auto),
    [sandbox]
  );
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
          {options.map((option) => {
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
