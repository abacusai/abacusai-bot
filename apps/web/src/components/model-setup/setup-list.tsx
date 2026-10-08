import { isPlausibleApiKey } from "@abacus-ai/contract/settings";
import { Cpu, Settings2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ConnectorMark,
  markForProvider,
} from "#renderer/components/connector-mark";
import { errorText } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Command, CommandItem, CommandList } from "#renderer/ui/command";
import { Field, FieldLabel } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";
import { Skeleton } from "#renderer/ui/skeleton";

import type { ModelSetupBinding } from "./types";

export const ModelSetupPopover = ({
  setup,
  open,
  onOpenChange,
  hint,
  children,
  connected,
}: {
  setup: ModelSetupBinding;
  open: boolean;
  onOpenChange(open: boolean): void;
  hint: boolean;
  connected(): void;
  children: React.ReactElement;
}) => {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<void>, success = false) => {
    setError(null);
    setPending(true);
    try {
      await action();
      if (success) connected();
      setProvider(null);
      setKey("");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={children} />
      <PopoverContent
        data-slot="chat-model-panel"
        side="top"
        align="end"
        sideOffset={8}
        initialFocus={list}
        className="w-[min(360px,var(--available-width))] min-w-0 gap-1 rounded-[14px] p-1.5 text-[13px]"
      >
        {hint ? (
          <p role="status" className="text-muted-foreground px-2 py-1.5">
            {t("chat.modelSetup.sendHint")}
          </p>
        ) : null}
        {setup.status === "loading" ? (
          <div
            aria-label={t("common.loading")}
            aria-busy="true"
            className="flex flex-col gap-1 p-1"
          >
            {[0, 1, 2].map((id) => (
              <Skeleton key={id} className="h-8 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <Command
            ref={list}
            tabIndex={0}
            shouldFilter={false}
            label={t("chat.modelSetup.choose")}
            className="bg-transparent p-0"
          >
            <CommandList className="scroll-fade-y max-h-[min(320px,var(--available-height))]">
              {setup.status === "error" ? (
                <>
                  <p role="alert" className="px-2 py-1.5">
                    {t("chat.modelSetup.fetchError")}
                  </p>
                  <CommandItem onSelect={() => void perform(setup.retry)}>
                    {t("common.retry")}
                  </CommandItem>
                </>
              ) : (
                setup.providers.map((row) => (
                  <CommandItem
                    key={row.id}
                    value={row.id}
                    disabled={pending}
                    className="h-8 rounded-lg px-2 py-1 text-[13px]"
                    onSelect={() => {
                      setError(null);
                      if (row.connected) setup.settings(row.id);
                      else if (row.connect)
                        void perform(() => setup.connect(row.id), true);
                      else {
                        setProvider(row.id);
                        setKey("");
                      }
                    }}
                  >
                    <ConnectorMark
                      id={markForProvider(row.id) ?? row.id}
                      size={16}
                    />
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t(
                        row.connected
                          ? "phase5.connected"
                          : row.connect
                            ? "phase5.connect"
                            : "phase5.addKey"
                      )}
                    </span>
                  </CommandItem>
                ))
              )}
              {setup.providers.some((row) => row.connected) ? (
                <p className="text-muted-foreground px-2 py-1.5">
                  {t("chat.modelSetup.noAvailable")}
                </p>
              ) : null}
              {setup.localAvailable ? (
                <CommandItem
                  value="local"
                  className="h-8 rounded-lg px-2 py-1 text-[13px]"
                  onSelect={() => setup.settings("local")}
                >
                  <Cpu aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {t("chat.composer.onThisMachine")}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t("phase5.download")}
                  </span>
                </CommandItem>
              ) : null}
              <CommandItem
                value="settings"
                className="mt-1 h-8 rounded-lg border-t px-2 py-1 text-[13px]"
                onSelect={() => setup.settings()}
              >
                <Settings2 aria-hidden />
                <span className="truncate">
                  {t("chat.modelSetup.allSettings")}
                </span>
              </CommandItem>
            </CommandList>
          </Command>
        )}
        {provider ? (
          <form
            className="flex flex-col gap-2 border-t p-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!isPlausibleApiKey(key.trim())) {
                setError(t("phase5.invalidKey"));
                return;
              }
              void perform(() => setup.save(provider, key.trim()), true);
            }}
          >
            <Field>
              <FieldLabel htmlFor="model-setup-key">
                {t("phase5.apiKey")}
              </FieldLabel>
              <Input
                id="model-setup-key"
                autoFocus
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </Field>
            <p className="text-muted-foreground text-xs">
              {t("phase5.storedHere")}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setProvider(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button size="sm" disabled={pending}>
                {t("phase5.save")}
              </Button>
            </div>
          </form>
        ) : null}
        {pending ? (
          <p role="status" className="text-muted-foreground px-2 py-1">
            {t("common.loading")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive px-2 py-1">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
};
