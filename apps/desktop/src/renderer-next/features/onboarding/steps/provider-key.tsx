import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Transport } from "#next/data/transport";
import { Button } from "#next/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#next/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "#next/ui/dropdown-menu";
import { Field, FieldLabel, FieldDescription } from "#next/ui/field";
import { Input } from "#next/ui/input";
import { isPlausibleApiKey, PROVIDER_KEY_FIELDS } from "#shared/settings";
export const OnboardingProviderKey = ({
  transport,
  saved,
}: {
  transport: Transport;
  saved(): Promise<unknown>;
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("gemini");
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
        setOpen(false);
      } catch {
        setError("save");
      }
    },
  });
  const field = PROVIDER_KEY_FIELDS.find((f) => f.provider === provider);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>
          {t("onboarding.pages.addKey")}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {PROVIDER_KEY_FIELDS.filter((entry) => entry.kind === "model").map(
            (entry) => (
              <DropdownMenuItem
                key={entry.provider}
                onClick={() => {
                  setProvider(entry.provider);
                  setError(null);
                  form.reset();
                  setOpen(true);
                }}
              >
                {entry.label}
              </DropdownMenuItem>
            )
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("onboarding.setupKeyDialogTitle", { provider: field?.label })}
            </DialogTitle>
            <DialogDescription>
              {t("onboarding.pages.keyPrivate")}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
            className="flex flex-col gap-4"
          >
            <form.Field name="key">
              {(f) => (
                <Field data-invalid={error === "validation"}>
                  <FieldLabel htmlFor="onboarding-key">
                    {t("onboarding.pages.addKey")}
                  </FieldLabel>
                  <Input
                    id="onboarding-key"
                    type="password"
                    value={f.state.value}
                    onChange={(event) => f.handleChange(event.target.value)}
                    aria-invalid={error === "validation"}
                    aria-describedby={
                      error ? "onboarding-key-error" : undefined
                    }
                  />
                  {error && (
                    <FieldDescription id="onboarding-key-error" role="alert">
                      {error === "validation"
                        ? t("onboarding.setupKeyInvalid")
                        : `${t("settings.saveFailed")}. ${t("onboarding.pages.retry")}`}
                    </FieldDescription>
                  )}
                </Field>
              )}
            </form.Field>
            {field?.signupUrl && (
              <Button
                variant="ghost"
                onClick={() =>
                  void transport.client.system.openExternal({
                    url: field.signupUrl!,
                  })
                }
              >
                {field.label}
              </Button>
            )}
            <Button type="submit">{t("bots.save")}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
