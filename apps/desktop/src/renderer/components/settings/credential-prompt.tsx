import { Check, ExternalLink } from "lucide-react";
import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { mcpOAuthRedirectUri } from "#shared/contracts";

import type { ConnectorDefinition } from "../../connectors";
import { Button, Field, FieldGroup, FieldLabel, Input } from "../ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

/** Collects the token or keys a connector needs, with a link to where to get one. */
export const CredentialPrompt = ({
  connector,
  onCancel,
  onSubmit,
}: {
  connector: ConnectorDefinition;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const fields =
    connector.auth === "token"
      ? ["token"]
      : connector.auth === "oauth-client"
        ? ["clientId", "clientSecret"]
        : (connector.env ?? []);
  // A public client is legitimate; not every provider issues a secret.
  const optional = new Set(["clientSecret"]);
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = fields.every(
    (field) => optional.has(field) || (values[field] ?? "").trim().length > 0
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="sm:max-w-md"
        data-id="connector-credential-prompt"
      >
        <DialogHeader>
          <DialogTitle>
            {t("connectors.connect", { name: connector.name })}
          </DialogTitle>
          <DialogDescription>
            {connector.auth === "oauth-client"
              ? t("connectors.oauthClientHint")
              : t("connectors.credentialHint")}
          </DialogDescription>
        </DialogHeader>

        {/* What to go and make, before any of the boxes below can be filled.
            Without it the dialog assumes the user already knows an app or a
            token has to exist somewhere else first, which is the one thing
            they are least likely to know. */}
        {connector.setup != null && connector.setup.length > 0 && (
          <ol
            className="text-secondary-foreground marker:text-muted-foreground mt-3 list-decimal space-y-1 pl-4 text-xs"
            data-id="connector-credential-setup"
          >
            {connector.setup.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}

        {/* The app being created has to name this exact URL, or the redirect
            comes back to a client the provider does not recognise. */}
        {connector.auth === "oauth-client" && (
          <div className="border-border bg-muted/50 mt-3 rounded-lg border px-3 py-2">
            <p className="text-muted-foreground text-[0.625rem] tracking-widest uppercase">
              {t("connectors.redirectUrlLabel")}
            </p>
            <code className="text-foreground mt-0.5 block font-mono text-xs break-all">
              {mcpOAuthRedirectUri()}
            </code>
          </div>
        )}

        <FieldGroup>
          {fields.map((field) => {
            const described = connector.fields?.[field];
            const label =
              field === "token"
                ? (connector.token?.label ?? t("connectors.token"))
                : field === "clientId" || field === "clientSecret"
                  ? t(`connectors.${field}`)
                  : (described?.label ?? field);
            // Masked unless the catalog says otherwise; undescribed fields
            // default to secret, the safe direction to be wrong in.
            const secret = described == null || described.secret === true;

            return (
              <Field key={field}>
                <FieldLabel htmlFor={`connector-credential-${field}`}>
                  {label}
                </FieldLabel>
                <Input
                  id={`connector-credential-${field}`}
                  type={secret ? "password" : "text"}
                  autoFocus={field === fields[0]}
                  value={values[field] ?? ""}
                  onChange={(event) =>
                    setValues((prev) => ({
                      ...prev,
                      [field]: event.target.value,
                    }))
                  }
                  data-id={`connector-credential-${field}`}
                  {...(described?.placeholder != null
                    ? { placeholder: described.placeholder }
                    : {})}
                />
              </Field>
            );
          })}
        </FieldGroup>

        <Button
          variant="link"
          size="sm"
          onClick={() => void window.api?.openExternal?.(connector.docsUrl)}
          className="mt-3"
          data-id="connector-credential-docs"
        >
          <ExternalLink />
          {t("connectors.whereToGet")}
        </Button>

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={onCancel}
            data-id="connector-credential-cancel"
          >
            {t("connectors.cancel")}
          </Button>
          <Button
            disabled={!complete}
            onClick={() => onSubmit(values)}
            data-id="connector-credential-submit"
          >
            <Check />
            {t("connectors.connectAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
