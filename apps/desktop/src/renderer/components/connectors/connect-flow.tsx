import { Check, ExternalLink } from "lucide-react";
import { useCallback, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { ConnectorOutcome } from "#shared/contracts";
import { mcpOAuthRedirectUri } from "#shared/contracts";
import type { MessagingPlatformId } from "#shared/messaging";

import {
  connectUi,
  type ConnectorDefinition,
  type CredentialConnector,
  type McpConnector,
} from "../../connectors";
import { signInToAbacus } from "../../lib/abacus-sign-in";
import {
  isMessagingPlatformConnected,
  MessagingConnectorDialog,
  useMessaging,
} from "../settings/messaging-connectors";
import { Button, Field, FieldGroup, FieldLabel, Input } from "../ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

/**
 * Connecting a connector, whatever its kind, from any surface. The registry
 * says what each kind needs (`connectUi`); this runs it: a browser hop or a
 * plain install goes straight to main, a kind that takes fields opens the one
 * fields dialog, a chat app opens its pairing dialog. Every path resolves to
 * the same outcome, so a caller — the Connectors page, onboarding, the card
 * the agent raised in a chat — never branches on kind itself.
 */

export type ConnectResult = ConnectorOutcome;

type FieldsAsk = {
  connector: CredentialConnector | McpConnector;
  resolve: (result: ConnectResult) => void;
};

type PairingAsk = {
  platform: MessagingPlatformId;
  resolve: (result: ConnectResult) => void;
};

export interface ConnectFlow {
  /** Run the connector's flow; resolves when it is over, however it ended. */
  start: (connector: ConnectorDefinition) => Promise<ConnectResult>;
  /** Give up on a browser hop in flight, resolving it as cancelled. */
  cancel: () => void;
  /** The dialogs the flow may need; mount once wherever `start` is used. */
  dialogs: JSX.Element;
}

export const useConnectFlow = (): ConnectFlow => {
  const messaging = useMessaging();
  const [fieldsAsk, setFieldsAsk] = useState<FieldsAsk | null>(null);
  const [pairingAsk, setPairingAsk] = useState<PairingAsk | null>(null);
  // The pairing dialog's close handler reads the gateway, and the gateway's
  // snapshot lands through the hook: keep the latest to hand.
  const messagingRef = useRef(messaging);
  messagingRef.current = messaging;

  const start = useCallback(
    async (connector: ConnectorDefinition): Promise<ConnectResult> => {
      const ui = connectUi(connector);

      if (ui === "fields") {
        return new Promise<ConnectResult>((resolve) => {
          setFieldsAsk({
            connector: connector as CredentialConnector | McpConnector,
            resolve,
          });
        });
      }

      if (ui === "pairing" && connector.kind === "messaging") {
        // Connecting is what starts a linked-device platform, so enable on
        // open: the dialog then has a QR to show by the time it appears.
        void messagingRef.current.connectPlatform(connector.platform);
        return new Promise<ConnectResult>((resolve) => {
          setPairingAsk({ platform: connector.platform, resolve });
        });
      }

      // A platform hop needs the account; the free signup happens inside
      // the same browser hop, so a signed-out click just starts there.
      if (connector.kind === "platform") {
        const statuses = await window.api?.agent?.listConnectorStatuses?.();
        if (statuses?.[connector.id]?.reason === "not-signed-in") {
          const auth = await signInToAbacus();
          if (auth.ok !== true)
            return {
              ok: false,
              error: "not-signed-in",
              ...(auth.cancelled === true ? { cancelled: true } : {}),
            };
        }
      }

      return (
        (await window.api?.agent?.connectConnector?.(connector.id)) ?? {
          ok: false,
          error: "Connecting is not available.",
        }
      );
    },
    []
  );

  const cancel = useCallback((): void => {
    void window.api?.agent?.cancelConnectorConnect?.();
  }, []);

  const dialogs = (
    <>
      {fieldsAsk != null && (
        <ConnectorFieldsDialog
          connector={fieldsAsk.connector}
          onCancel={() => {
            const ask = fieldsAsk;
            setFieldsAsk(null);
            ask.resolve({ ok: false, error: "cancelled", cancelled: true });
          }}
          onSubmit={(values) => {
            const ask = fieldsAsk;
            setFieldsAsk(null);
            void (async () => {
              ask.resolve(
                (await window.api?.agent?.submitConnectorFields?.(
                  ask.connector.id,
                  values
                )) ?? { ok: false, error: "Connecting is not available." }
              );
            })();
          }}
        />
      )}
      {pairingAsk != null && (
        <MessagingConnectorDialog
          platformId={pairingAsk.platform}
          messaging={messaging}
          onClose={() => {
            const ask = pairingAsk;
            setPairingAsk(null);
            // The gateway's LIVE state is the authority on whether the
            // platform is linked, not enabled-and-configured: a WhatsApp
            // dialog closed before the QR was scanned is not connected.
            void (async () => {
              const snapshot =
                await window.api?.agent?.getMessagingSnapshot?.();
              ask.resolve(
                snapshot != null &&
                  isMessagingPlatformConnected(snapshot, ask.platform)
                  ? { ok: true }
                  : { ok: false, error: "not-linked", cancelled: true }
              );
            })();
          }}
        />
      )}
    </>
  );

  return { start, cancel, dialogs };
};

/** The fields a kind asks for, in order; `optional` ones may be left blank. */
const fieldsFor = (
  connector: CredentialConnector | McpConnector
): { names: string[]; optional: Set<string> } => {
  if (connector.kind === "credential")
    return { names: Object.keys(connector.fields), optional: new Set() };
  if (connector.auth === "token")
    return { names: ["token"], optional: new Set() };
  if (connector.auth === "oauth-client")
    // A public client is legitimate; not every provider issues a secret.
    return {
      names: ["clientId", "clientSecret"],
      optional: new Set(["clientSecret"]),
    };
  return { names: [...(connector.env ?? [])], optional: new Set() };
};

/**
 * Collects the token or keys a connector needs, with a link to where to get
 * one. The one dialog for every kind that takes fields, on every surface.
 */
export const ConnectorFieldsDialog = ({
  connector,
  onCancel,
  onSubmit,
}: {
  connector: CredentialConnector | McpConnector;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const { names, optional } = fieldsFor(connector);
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = names.every(
    (field) => optional.has(field) || (values[field] ?? "").trim().length > 0
  );
  const isOauthClient =
    connector.kind === "mcp" && connector.auth === "oauth-client";

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
            {isOauthClient
              ? t("connectors.oauthClientHint")
              : connector.kind === "credential"
                ? t("connectors.agentKeyHint")
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
        {isOauthClient && (
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
          {names.map((field) => {
            const described = connector.fields?.[field];
            const label =
              field === "token"
                ? (connector.kind === "mcp" && connector.token?.label) ||
                  t("connectors.token")
                : field === "clientId" || field === "clientSecret"
                  ? t(`connectors.${field}`)
                  : (described?.label ?? field);
            // Masked unless the registry says otherwise; undescribed fields
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
                  autoFocus={field === names[0]}
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
