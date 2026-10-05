import {
  createFormHook,
  createFormHookContexts,
  useStore,
} from "@tanstack/react-form";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";
import {
  Field,
  FieldLabel,
  FieldError,
  FieldDescription,
} from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";
import { Spinner } from "#renderer/ui/spinner";
import { Textarea } from "#renderer/ui/textarea";
const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts();
const TextField = ({
  label,
  max,
  multiline = false,
  errorKeyPrefix = "bots.form.validation",
}: {
  label: string;
  max: number;
  multiline?: boolean;
  errorKeyPrefix?: string;
}) => {
  const { t } = useTranslation();
  const field = useFieldContext<string>();
  const attempts = useStore(
    field.form.store,
    (state) => state.submissionAttempts
  );
  const errors =
    field.state.meta.isBlurred || attempts > 0 ? field.state.meta.errors : [];
  const invalid = errors.length > 0;
  const id = `bot-field-${field.name}`;
  const props = {
    id,
    name: field.name,
    "data-continuity-id": id,
    value: field.state.value,
    onBlur: field.handleBlur,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
    ) => field.handleChange(event.target.value),
    "aria-invalid": invalid,
    "aria-describedby": invalid ? `${id}-error` : undefined,
    className: "bg-muted rounded-[10px]",
  };
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? (
        <Textarea
          {...props}
          className={`${props.className} field-sizing-content max-h-60 min-h-24`}
        />
      ) : (
        <Input {...props} />
      )}
      {field.state.value.length >= max * 0.8 && (
        <FieldDescription
          aria-live={field.state.value.length >= max ? "polite" : "off"}
        >
          {field.state.value.length}/{max}
        </FieldDescription>
      )}
      {invalid && (
        <FieldError id={`${id}-error`}>
          {errors
            .map((error) =>
              typeof error === "object" && error && "message" in error
                ? t(`${errorKeyPrefix}.${error.message}`)
                : t("bots.form.validation.required")
            )
            .join(" ")}
        </FieldError>
      )}
    </Field>
  );
};
const SubmitButton = ({ label }: { label: string }) => {
  const form = useFormContext();
  return (
    <form.Subscribe
      selector={(s) =>
        [s.canSubmit, s.isSubmitting, s.submissionAttempts] as const
      }
    >
      {([canSubmit, busy, attempts]) => (
        <Button
          type="submit"
          className="bot-accent-control"
          disabled={busy || (!canSubmit && attempts > 0)}
        >
          {busy && <Spinner />}
          {label}
        </Button>
      )}
    </form.Subscribe>
  );
};
export const { useAppForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField },
  formComponents: { SubmitButton },
});
