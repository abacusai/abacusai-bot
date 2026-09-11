import { AlertTriangle, GitBranch, Plus, Search } from "lucide-react";
import {
  startTransition,
  useDeferredValue,
  useMemo,
  useOptimistic,
  useState,
  type JSX,
} from "react";
import { useTranslation } from "react-i18next";

import { Button, Spinner } from "../ui";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "../ui/combobox";
import { InputGroupAddon } from "../ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export const BranchPicker = ({
  branches,
  currentBranch,
  isLoading,
  isMutating,
  switchingBranch,
  onSwitchBranch,
  onCreateBranch,
  branchError,
  isAgentBusy,
}: {
  branches: string[];
  currentBranch: string | null;
  isLoading: boolean;
  isMutating: boolean;
  switchingBranch: string | null;
  onSwitchBranch: (name: string) => void;
  onCreateBranch: (name: string) => void;
  branchError: string | null;
  isAgentBusy: boolean;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [optimisticBranch, setOptimisticBranch] = useOptimistic(currentBranch);
  const trimmedSearch = deferredSearch.trim();
  const filteredBranches = useMemo(() => {
    const query = trimmedSearch.toLocaleLowerCase();
    return query.length === 0
      ? branches
      : branches.filter((branch) => branch.toLocaleLowerCase().includes(query));
  }, [branches, trimmedSearch]);
  const canCreate =
    trimmedSearch.length > 0 && !branches.includes(trimmedSearch);
  const items = canCreate
    ? [...filteredBranches, trimmedSearch]
    : filteredBranches;

  if (!isLoading && branches.length === 0 && branchError == null) return null;

  const selectBranch = (branch: string): void => {
    if (isAgentBusy || isMutating) return;
    startTransition(() => {
      setOptimisticBranch(branch);
      if (branches.includes(branch)) onSwitchBranch(branch);
      else onCreateBranch(branch);
    });
  };

  return (
    <Combobox
      items={items}
      filteredItems={items}
      filter={null}
      value={optimisticBranch}
      onOpenChange={(open) => {
        if (!open) setSearch("");
      }}
      onValueChange={(branch) => {
        if (typeof branch === "string") selectBranch(branch);
      }}
    >
      <Tooltip>
        <TooltipTrigger render={<div className="inline-flex min-w-0" />}>
          <ComboboxTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                data-id="local-code-branch-selector"
                className="max-w-48 min-w-0 border border-transparent"
              />
            }
          >
            {isMutating ? <Spinner /> : <GitBranch />}
            <span className="truncate">
              {isLoading
                ? t("workspace.branch.loading")
                : (switchingBranch ?? optimisticBranch ?? "branch")}
            </span>
          </ComboboxTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("workspace.branch.description")}</TooltipContent>
      </Tooltip>
      <ComboboxContent side="top" align="end" className="w-80">
        <ComboboxInput
          showTrigger={false}
          className="w-auto"
          placeholder={t("workspace.branch.searchOrCreate")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        >
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
        </ComboboxInput>
        {branchError != null && (
          <div className="text-destructive flex items-start gap-2 border-b px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{branchError}</span>
          </div>
        )}
        {isAgentBusy && (
          <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-2 text-xs">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span>{t("workspace.branch.stopAgentFirst")}</span>
          </div>
        )}
        <ComboboxList className="max-h-56">
          {isLoading ? (
            <div className="text-muted-foreground px-2 py-3 text-xs">
              {t("workspace.branch.loading")}
            </div>
          ) : (
            items.map((branch) => {
              const isCreate = canCreate && branch === trimmedSearch;
              return (
                <ComboboxItem
                  key={`${isCreate ? "create" : "branch"}:${branch}`}
                  value={branch}
                  disabled={isAgentBusy || isMutating}
                >
                  {isCreate ? <Plus /> : <GitBranch />}
                  <span className="truncate">
                    {isCreate
                      ? t("workspace.branch.create", { branch })
                      : branch}
                  </span>
                </ComboboxItem>
              );
            })
          )}
        </ComboboxList>
        <ComboboxEmpty>{t("workspace.branch.noResults")}</ComboboxEmpty>
        <div className="text-muted-foreground border-t px-3 py-1.5 text-xs">
          {t("workspace.branch.showing", {
            count: filteredBranches.length,
            total: branches.length,
          })}
        </div>
      </ComboboxContent>
    </Combobox>
  );
};
