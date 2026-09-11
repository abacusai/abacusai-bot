import { Check, Plus, Trash2 } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { McpServerEntry } from "#shared/contracts";

import {
  Button,
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  ToggleGroup,
  ToggleGroupItem,
} from "../ui";

type Transport = "stdio" | "http";

interface KvPair {
  key: string;
  value: string;
}

interface McpServerFormProps {
  /** Existing entry name in edit mode; null/undefined in add mode. */
  initialName?: string | null;
  initialEntry?: McpServerEntry | null;
  onCancel: () => void;
  onSave: (
    name: string,
    entry: McpServerEntry
  ) => Promise<{ success: boolean; error?: string }>;
}

const detectTransport = (entry?: McpServerEntry | null): Transport => {
  if (entry?.url != null && entry.url !== "") return "http";
  return "stdio";
};

const recordToPairs = (record?: Record<string, string>): KvPair[] => {
  if (record == null) return [];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
};

const pairsToRecord = (pairs: KvPair[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (k === "") continue;
    out[k] = value;
  }
  return out;
};

export const McpServerForm = ({
  initialName,
  initialEntry,
  onCancel,
  onSave,
}: McpServerFormProps): React.ReactElement => {
  const { t } = useTranslation();
  const isEdit = initialName != null;
  const [transport, setTransport] = useState<Transport>(
    detectTransport(initialEntry)
  );
  const [name, setName] = useState(initialName ?? "");
  const [command, setCommand] = useState(initialEntry?.command ?? "");
  const [args, setArgs] = useState<string[]>(initialEntry?.args ?? []);
  const [env, setEnv] = useState<KvPair[]>(recordToPairs(initialEntry?.env));
  const [url, setUrl] = useState(initialEntry?.url ?? "");
  const [headers, setHeaders] = useState<KvPair[]>(
    recordToPairs(initialEntry?.headers)
  );
  const initialOauth =
    initialEntry?.oauth !== false ? initialEntry?.oauth : undefined;
  const [clientId, setClientId] = useState(initialOauth?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(
    initialOauth?.clientSecret ?? ""
  );
  const [scope, setScope] = useState(initialOauth?.scope ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildEntry = useMemo(
    () => (): McpServerEntry => {
      if (transport === "stdio") {
        const entry: McpServerEntry = { command: command.trim() };
        const cleanArgs = args.map((a) => a.trim()).filter((a) => a !== "");
        if (cleanArgs.length > 0) entry.args = cleanArgs;
        const cleanEnv = pairsToRecord(env);
        if (Object.keys(cleanEnv).length > 0) entry.env = cleanEnv;
        return entry;
      }
      const entry: McpServerEntry = { url: url.trim() };
      const cleanHeaders = pairsToRecord(headers);
      if (Object.keys(cleanHeaders).length > 0) entry.headers = cleanHeaders;
      const oauth: NonNullable<Exclude<McpServerEntry["oauth"], false>> = {};
      if (clientId.trim() !== "") oauth.clientId = clientId.trim();
      if (clientSecret.trim() !== "") oauth.clientSecret = clientSecret.trim();
      if (scope.trim() !== "") oauth.scope = scope.trim();
      if (Object.keys(oauth).length > 0) entry.oauth = oauth;
      return entry;
    },
    [transport, command, args, env, url, headers, clientId, clientSecret, scope]
  );

  const handleSave = async (): Promise<void> => {
    setError(null);
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(t("mcpManagement.nameRequired"));
      return;
    }
    if (transport === "stdio" && command.trim() === "") {
      setError(t("mcpManagement.commandRequired"));
      return;
    }
    if (transport === "http" && url.trim() === "") {
      setError(t("mcpManagement.urlRequired"));
      return;
    }
    setSaving(true);
    try {
      const result = await onSave(trimmed, buildEntry());
      if (!result.success) {
        setError(result.error ?? t("mcpManagement.addFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-id="mcp-server-form">
      <Field>
        <FieldLabel htmlFor="mcp-form-name-input">
          {t("mcpManagement.form.name")}
        </FieldLabel>
        <Input
          id="mcp-form-name-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("mcpManagement.namePlaceholder")}
          disabled={isEdit}
          data-id="mcp-form-name"
        />
      </Field>

      <ToggleGroup
        value={[transport]}
        onValueChange={(values) => {
          const next = values.at(-1) as Transport | undefined;
          if (next != null) setTransport(next);
        }}
        variant="outline"
        spacing={0}
        className="w-full"
        aria-label={`${t("mcpManagement.form.transportStdio")} / ${t("mcpManagement.form.transportHttp")}`}
      >
        <ToggleGroupItem
          value="stdio"
          className="flex-1"
          data-id="mcp-form-transport-stdio"
        >
          {t("mcpManagement.form.transportStdio")}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="http"
          className="flex-1"
          data-id="mcp-form-transport-http"
        >
          {t("mcpManagement.form.transportHttp")}
        </ToggleGroupItem>
      </ToggleGroup>

      {transport === "stdio" ? (
        <>
          <Field>
            <FieldLabel htmlFor="mcp-form-command-input">
              {t("mcpManagement.form.command")}
            </FieldLabel>
            <Input
              id="mcp-form-command-input"
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("mcpManagement.form.commandPlaceholder")}
              data-id="mcp-form-command"
            />
          </Field>

          <DynamicList
            label={t("mcpManagement.form.arguments")}
            addLabel={t("mcpManagement.form.addArgument")}
            items={args}
            onChange={setArgs}
            dataIdPrefix="mcp-form-arg"
            placeholder={t("mcpManagement.form.argumentPlaceholder")}
            empty=""
          />

          <DynamicKv
            label={t("mcpManagement.form.env")}
            addLabel={t("mcpManagement.form.addEnv")}
            pairs={env}
            onChange={setEnv}
            dataIdPrefix="mcp-form-env"
          />
        </>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="mcp-form-url-input">
              {t("mcpManagement.form.url")}
            </FieldLabel>
            <Input
              id="mcp-form-url-input"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("mcpManagement.form.urlPlaceholder")}
              data-id="mcp-form-url"
            />
          </Field>

          <DynamicKv
            label={t("mcpManagement.form.headers")}
            addLabel={t("mcpManagement.form.addHeader")}
            pairs={headers}
            onChange={setHeaders}
            dataIdPrefix="mcp-form-header"
          />

          <div className="border-border space-y-2 border-t pt-1">
            <div className="text-muted-foreground pt-2 text-xs tracking-wide uppercase">
              {t("mcpManagement.form.oauthSection")}
            </div>
            <p className="text-muted-foreground text-xs">
              {t("mcpManagement.form.oauthHint")}
            </p>
            <Input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={t("mcpManagement.form.clientIdPlaceholder")}
              data-id="mcp-form-oauth-client-id"
            />
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={t("mcpManagement.form.clientSecretPlaceholder")}
              data-id="mcp-form-oauth-client-secret"
            />
            <Input
              type="text"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder={t("mcpManagement.form.scopePlaceholder")}
              data-id="mcp-form-oauth-scope"
            />
          </div>
        </>
      )}

      {error != null && <div className="text-destructive text-sm">{error}</div>}

      <div className="flex justify-end gap-2 pt-2">
        <Button
          variant="secondary"
          onClick={onCancel}
          disabled={saving}
          data-id="mcp-form-cancel"
        >
          {t("mcpManagement.cancel")}
        </Button>
        <Button onClick={handleSave} disabled={saving} data-id="mcp-form-save">
          <Check />
          {isEdit ? t("mcpManagement.save") : t("mcpManagement.add")}
        </Button>
      </div>
    </div>
  );
};

interface DynamicListProps {
  label: string;
  addLabel: string;
  items: string[];
  onChange: (next: string[]) => void;
  dataIdPrefix: string;
  placeholder: string;
  empty: string;
}

const DynamicList = ({
  label,
  addLabel,
  items,
  onChange,
  dataIdPrefix,
  placeholder,
}: DynamicListProps): React.ReactElement => {
  const update = (i: number, value: string): void => {
    const next = [...items];
    next[i] = value;
    onChange(next);
  };
  const remove = (i: number): void => {
    onChange(items.filter((_, idx) => idx !== i));
  };
  const add = (): void => {
    onChange([...items, ""]);
  };
  return (
    <FieldSet>
      <FieldLegend variant="label">{label}</FieldLegend>
      <div className="space-y-1.5">
        {items.map((value, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              type="text"
              value={value}
              onChange={(e) => update(i, e.target.value)}
              placeholder={placeholder}
              data-id={`${dataIdPrefix}-${i}`}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              className="hover:text-destructive"
              data-id={`${dataIdPrefix}-remove-${i}`}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          onClick={add}
          className="w-full border-dashed"
          data-id={`${dataIdPrefix}-add`}
        >
          <Plus />
          {addLabel}
        </Button>
      </div>
    </FieldSet>
  );
};

interface DynamicKvProps {
  label: string;
  addLabel: string;
  pairs: KvPair[];
  onChange: (next: KvPair[]) => void;
  dataIdPrefix: string;
}

const DynamicKv = ({
  label,
  addLabel,
  pairs,
  onChange,
  dataIdPrefix,
}: DynamicKvProps): React.ReactElement => {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<KvPair>): void => {
    const next = [...pairs];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const remove = (i: number): void => {
    onChange(pairs.filter((_, idx) => idx !== i));
  };
  const add = (): void => {
    onChange([...pairs, { key: "", value: "" }]);
  };
  return (
    <FieldSet>
      <FieldLegend variant="label">{label}</FieldLegend>
      <div className="space-y-1.5">
        {pairs.map((pair, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              type="text"
              value={pair.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder={t("mcpManagement.form.kvKey")}
              className="flex-1"
              data-id={`${dataIdPrefix}-key-${i}`}
            />
            <Input
              type="text"
              value={pair.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={t("mcpManagement.form.kvValue")}
              className="flex-1"
              data-id={`${dataIdPrefix}-value-${i}`}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              className="hover:text-destructive"
              data-id={`${dataIdPrefix}-remove-${i}`}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          onClick={add}
          className="w-full border-dashed"
          data-id={`${dataIdPrefix}-add`}
        >
          <Plus />
          {addLabel}
        </Button>
      </div>
    </FieldSet>
  );
};
