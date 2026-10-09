/**
 * The key dialog (canvas OnboardKeyDialog, spec 06 §7.5): "Go to {provider}
 * and get your API key", a masked input, `isPlausibleApiKey` → "That
 * doesn't look like an API key…", "Stored on this machine only.", Open
 * {provider} · Cancel · Save. `OnboardingProviderKey` is its trigger: one
 * provider ("Add API key" opens it directly) or the "Paste a key" picker
 * over every model provider.
 */
import {
  isPlausibleApiKey,
  PROVIDER_KEY_FIELDS,
} from "@abacus-ai/contract/settings";
import { useForm } from "@tanstack/react-form";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConnectDialogContent } from "#renderer/components/form-kit/connect-dialog";
import type { Transport } from "#renderer/data/transport";
import { platformSystem } from "#renderer/lib/platform-system";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";

import { StepButton, StepLink } from "./kit";

export const ProviderKeyDialog = ({
  transport,
  provider,
  open,
  onOpenChange,
  saved,
  finalFocus,
}: {
  transport: Transport;
  provider: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  saved(): Promise<unknown>;
  finalFocus?(): HTMLElement | null;
}) => {
  const { t } = useTranslation();
  const [error, setError] = useState<"validation" | "save" | null>(null);
  const form = useForm({
    defaultValues: { key: "" },
    onSubmit: async ({ value }) => {
      if (!isPlausibleApiKey(value.key)) {
        setError("validation");
        return;
      }
      setError(null);
      try {
        await transport.client.settings.keys.save({
          provider,
          key: value.key.trim(),
        });
        await saved();
        onOpenChange(false);
      } catch {
        setError("save");
      }
    },
  });
  const field = PROVIDER_KEY_FIELDS.find((f) => f.provider === provider);
  const label = field?.label ?? provider;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setError(null);
          form.reset();
        }
        onOpenChange(next);
      }}
    >
      <ConnectDialogContent
        className="sm:max-w-[480px]"
        finalFocus={finalFocus}
      >
        <DialogHeader className="text-left">
          <DialogTitle className="text-sm font-semibold">
            {t("onboarding.setupKeyDialogTitle", { provider: label })}
          </DialogTitle>
          <DialogDescription className="onboarding-quiet">
            {t("onboarding.setupKeyDialogBody")}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-1.5"
        >
          <form.Field name="key">
            {(f) => (
              <Field data-invalid={error === "validation"}>
                <FieldLabel htmlFor="onboarding-key" className="sr-only">
                  {t("onboarding.pages.addKey")}
                </FieldLabel>
                <Input
                  id="onboarding-key"
                  type="password"
                  autoFocus
                  autoComplete="off"
                  placeholder={t("onboarding.setupKeyPlaceholder", {
                    provider: label,
                  })}
                  className="h-11 rounded-[10px] font-mono text-[13px]"
                  value={f.state.value}
                  onChange={(event) => f.handleChange(event.target.value)}
                  aria-invalid={error === "validation"}
                  aria-describedby={
                    error ? "onboarding-key-error" : "onboarding-key-hint"
                  }
                />
                {error && (
                  <FieldDescription
                    id="onboarding-key-error"
                    role="alert"
                    className="text-destructive text-xs"
                  >
                    {error === "validation"
                      ? t("onboarding.setupKeyInvalid")
                      : `${t("phase5.saveFailed")}. ${t("onboarding.pages.retry")}`}
                  </FieldDescription>
                )}
                <FieldDescription
                  id="onboarding-key-hint"
                  className="onboarding-quiet text-xs"
                >
                  {t("onboarding.pages.keyPrivate")}
                </FieldDescription>
              </Field>
            )}
          </form.Field>
          <div className="mt-3 flex items-center gap-2">
            {field?.signupUrl && (
              <StepButton
                type="button"
                variant="secondary"
                onClick={() =>
                  void platformSystem(transport.client).openExternal({
                    url: field.signupUrl!,
                  })
                }
              >
                {t("onboarding.setupKeyDialogLink", { provider: label })}
              </StepButton>
            )}
            <span className="flex-1" />
            <StepLink type="button" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </StepLink>
            <StepButton type="submit">{t("bots.save")}</StepButton>
          </div>
        </form>
      </ConnectDialogContent>
    </Dialog>
  );
};

export const OnboardingProviderKey = ({
  transport,
  saved,
  provider: fixed,
}: {
  transport: Transport;
  saved(): Promise<unknown>;
  /** One provider: the button opens its dialog directly (no picker). */
  provider?: string;
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(fixed ?? "gemini");
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      {fixed ? (
        <StepButton ref={trigger} variant="small" onClick={() => setOpen(true)}>
          {t("onboarding.pages.addKey")}
        </StepButton>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            ref={trigger}
            render={
              <Button
                size="lg"
                variant="secondary"
                data-variant="small"
                className="onboarding-button"
              />
            }
          >
            {t("onboarding.pages.pasteKey")}
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {PROVIDER_KEY_FIELDS.filter((entry) => entry.kind === "model").map(
              (entry) => (
                <DropdownMenuItem
                  key={entry.provider}
                  onClick={() => {
                    setProvider(entry.provider);
                    setOpen(true);
                  }}
                >
                  {entry.label}
                </DropdownMenuItem>
              )
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {open && (
        <ProviderKeyDialog
          transport={transport}
          provider={provider}
          open={open}
          onOpenChange={setOpen}
          saved={saved}
          finalFocus={() => trigger.current}
        />
      )}
    </>
  );
};
