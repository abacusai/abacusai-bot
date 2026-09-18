import { CircleAlert, ExternalLink, Trash2 } from "lucide-react";
import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { isPlausibleApiKey, type ProviderKeyField } from "#shared/settings";

import { Button, Input, Spinner } from "../ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

/**
 * Paste a provider's API key. One dialog for onboarding, the models page and
 * the model picker: it names the errand (go to the console, make a key, come
 * back), carries the link, and stays open while the user is away. Nothing here
 * proves a key works; a paste that could not be one is refused in place.
 */
export const ProviderKeyDialog = ({
  field,
  open,
  configured = false,
  onClose,
  onSaved,
  onRemove,
}: {
  field: ProviderKeyField | null;
  open: boolean;
  /** A key is already in use, pasted or exported; a new paste replaces it. */
  configured?: boolean;
  onClose: () => void;
  /** The key is written and the model catalog re-read. */
  onSaved?: () => void | Promise<void>;
  /** Forget the stored key. Pass it only for a key this app wrote. */
  onRemove?: () => void | Promise<void>;
}): JSX.Element => {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);

  const close = (): void => {
    setValue("");
    setInvalid(false);
    onClose();
  };

  const save = async (): Promise<void> => {
    const key = value.trim();
    if (field == null || key.length === 0) return;
    if (!isPlausibleApiKey(key)) {
      setInvalid(true);
      return;
    }
    setSaving(true);
    try {
      await window.api.agent.saveApiKey(field.provider, key);
      // A new key changes which models exist, so the catalog is re-read.
      await window.api.agent.listModels(true);
      setValue("");
      await onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open && field != null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {field != null && (
        <DialogContent className="sm:max-w-lg" data-id="provider-key-dialog">
          <DialogHeader>
            <DialogTitle data-id="provider-key-title">
              {t("onboarding.setupKeyDialogTitle", { provider: field.label })}
            </DialogTitle>
            <DialogDescription>
              {t("onboarding.setupKeyDialogBody")}
            </DialogDescription>
          </DialogHeader>

          <Button
            variant="link"
            size="sm"
            data-id="provider-key-link"
            onClick={() => window.api.openExternal(field.signupUrl)}
            className="text-primary h-auto justify-start p-0 text-sm"
          >
            {t("onboarding.setupKeyDialogLink", { provider: field.label })}
            <ExternalLink className="size-3.5" />
          </Button>

          {configured && (
            // A pasted key is stored, not proven: saying so beats a checkmark
            // that turns into an auth error on the first turn.
            <div
              className="border-border bg-muted/40 text-muted-foreground flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs"
              data-id="provider-key-state"
            >
              <CircleAlert size={11} />
              <span className="truncate">{t("apiKeys.notVerified")}</span>
            </div>
          )}

          <Input
            type="password"
            autoFocus
            data-id="provider-key-input"
            value={value}
            placeholder={t(
              configured
                ? "apiKeys.replacePlaceholder"
                : "onboarding.setupKeyPlaceholder",
              { provider: field.label }
            )}
            onChange={(event) => {
              setInvalid(false);
              setValue(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
          <span
            className="text-muted-foreground text-xs"
            data-id="provider-key-hint"
          >
            {invalid
              ? t("onboarding.setupKeyInvalid")
              : t("onboarding.setupKeyHint")}
          </span>

          <DialogFooter>
            {onRemove != null && (
              <Button
                variant="ghost"
                data-id="provider-key-remove"
                onClick={() => void onRemove()}
                className="text-destructive mr-auto"
              >
                <Trash2 size={13} />
                {t("apiKeys.remove")}
              </Button>
            )}
            <Button
              variant="secondary"
              data-id="provider-key-cancel"
              onClick={close}
            >
              {t("common.cancel")}
            </Button>
            <Button
              data-id="provider-key-save"
              disabled={saving || value.trim().length === 0}
              onClick={() => void save()}
            >
              {saving && <Spinner fontSize={11} />}
              {t("onboarding.setupSaveCta")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
};
