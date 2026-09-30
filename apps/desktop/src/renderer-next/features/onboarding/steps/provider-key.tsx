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
  const [error, setError] = useState(false);
  const form = useForm({
    defaultValues: { key: "" },
    onSubmit: async ({ value }) => {
      if (!isPlausibleApiKey(value.key)) {
        setError(true);
        return;
      }
      try {
        await transport.client.settings.keys.save({
          provider: "gemini",
          key: value.key.trim(),
        });
        await saved();
        setOpen(false);
      } catch {
        setError(true);
      }
    },
  });
  const field = PROVIDER_KEY_FIELDS.find((f) => f.provider === "gemini");
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        {t("onboarding.pages.addKey")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("onboarding.pages.keyTitle")}</DialogTitle>
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
                <Field data-invalid={error}>
                  <FieldLabel htmlFor="onboarding-key">
                    {t("onboarding.pages.addKey")}
                  </FieldLabel>
                  <Input
                    id="onboarding-key"
                    type="password"
                    value={f.state.value}
                    onChange={(event) => f.handleChange(event.target.value)}
                    aria-invalid={error}
                    aria-describedby={
                      error ? "onboarding-key-error" : undefined
                    }
                  />
                  {error && (
                    <FieldDescription id="onboarding-key-error" role="alert">
                      {t("onboarding.setupKeyInvalid")}
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
                {t("onboarding.pages.openGemini")}
              </Button>
            )}
            <Button type="submit">{t("bots.save")}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
