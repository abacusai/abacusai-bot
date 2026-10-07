import type {
  PrefsAppearance,
  PrefsRow,
} from "@abacus-ai/contract/contract/rows";
/**
 * Appearance settings: the theme gallery (each card a mini app painted with
 * that theme's real derived tokens), mode, accent, contrast, corners, fonts,
 * window translucency where the platform has it, and importing a VS Code
 * theme. Every control writes prefs optimistically; ThemeEffect re-themes
 * the app as the row changes, so the page itself is the live preview.
 */
import { THEME_FILE_MAX_BYTES } from "@abacus-ai/contract/look";
import { useQuery } from "@tanstack/react-query";
import {
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { pickThemeFile, WINDOW_TRANSLUCENCY } from "#platform/appearance";
import {
  Segments,
  SettingSwitch,
} from "#renderer/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
} from "#renderer/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { windowChromeQuery } from "#renderer/data/queries/window";
import { useMutation } from "#renderer/data/query-client";
import {
  ACCENTS,
  findTheme,
  lookOf,
  THEMES,
  themeTokens,
  type LookTheme,
} from "#renderer/lib/look";
import { IS_ELECTRON } from "#renderer/lib/platform";
import {
  CONTRAST_QUERY,
  DARK_QUERY,
  resolveTheme,
  type ResolvedTheme,
} from "#renderer/lib/theme";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useMediaQuery } from "#renderer/lib/use-media-query";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";
import { Input } from "#renderer/ui/input";
import { Textarea } from "#renderer/ui/textarea";

import { importVsCodeTheme, ThemeImportError } from "./vscode-theme";

/**
 * A radio group as the WAI-ARIA pattern has it: one tab stop (the checked
 * radio, else the first), arrow keys move and select, Home/End jump. The
 * registry has no radio group (Base UI stays inside ui/), so the pattern is
 * kept here, small. Selection shows as a ring; keyboard focus as a separate
 * dashed outline.
 */
const Choices = ({
  labelledBy,
  value,
  onChange,
  className,
  options,
}: {
  labelledBy: string;
  value: string;
  onChange(value: string): void;
  className: string;
  options: readonly {
    value: string;
    label?: string;
    className: string;
    style?: CSSProperties;
    children?: ReactNode;
  }[];
}) => {
  const checked = options.findIndex((option) => option.value === value);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : step === 0
            ? -1
            : (Math.max(checked, 0) + step + options.length) % options.length;
    if (to < 0) return;
    event.preventDefault();
    onChange(options[to]!.value);
    event.currentTarget
      .querySelectorAll<HTMLElement>('[role="radio"]')
      [to]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className={className}
      onKeyDown={move}
    >
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={i === checked}
          aria-label={option.label}
          tabIndex={i === (checked < 0 ? 0 : checked) ? 0 : -1}
          className={`${CHOICE} ${option.className}`}
          style={option.style}
          onClick={() => onChange(option.value)}
        >
          {option.children}
        </button>
      ))}
    </div>
  );
};
const CHOICE =
  "aria-checked:ring-primary ring-2 ring-transparent outline-offset-4 focus-visible:outline-2 focus-visible:outline-dashed focus-visible:outline-[var(--ring)] cursor-pointer";

const bar = (color: string, width: string): CSSProperties => ({
  background: `var(--${color})`,
  width,
});

/**
 * A mini app in one theme: sidebar rows, a user bubble, reply lines, a
 * highlighted code line, a diff and the accent send button, all from the
 * theme's derived tokens scoped to this box.
 */
export const ThemePreview = ({
  theme,
  mode,
  accent,
  high,
}: {
  theme: LookTheme;
  mode: ResolvedTheme;
  accent: string | null;
  high: boolean;
}) => {
  const tokens = themeTokens(theme, mode, { accent, high });
  const style = Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => [`--${key}`, value])
  ) as CSSProperties;
  return (
    <div
      aria-hidden
      data-slot="theme-preview"
      style={style}
      className="bg-background border-border flex h-24 overflow-hidden rounded-md border"
    >
      <div className="bg-sidebar border-sidebar-border flex w-1/4 flex-col gap-1 border-r p-1.5">
        <span className="bg-sidebar-accent h-2 rounded-sm" />
        {["70%", "55%", "62%"].map((width) => (
          <span
            key={width}
            className="h-1 rounded-sm"
            style={bar("sidebar-muted-foreground", width)}
          />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-1.5">
        <span
          className="h-2.5 self-end rounded-md"
          style={bar("chat-user-bubble", "45%")}
        />
        <span className="h-1 rounded-sm" style={bar("foreground", "80%")} />
        <span
          className="h-1 rounded-sm"
          style={bar("muted-foreground", "60%")}
        />
        <span
          className="border-border flex gap-1 rounded-sm border p-1"
          style={bar("th-background", "100%")}
        >
          {(
            ["th-keyword", "th-function", "th-string", "th-number"] as const
          ).map((key) => (
            <span
              key={key}
              className="h-1 flex-1 rounded-sm"
              style={bar(key, "auto")}
            />
          ))}
        </span>
        <span
          className="h-1.5 rounded-sm"
          style={bar("chat-diff-add-bg", "100%")}
        />
        <span
          className="h-1.5 rounded-sm"
          style={bar("chat-diff-del-bg", "100%")}
        />
        <span className="bg-primary mt-auto size-2.5 self-end rounded-full" />
      </div>
    </div>
  );
};

type Patch = Partial<PrefsAppearance>;

const FontInput = ({
  id,
  value,
  fonts,
  onSave,
}: {
  id: string;
  value: string;
  fonts: string[];
  onSave(value: string): void;
}) => (
  <>
    <Input
      key={value}
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-detail`}
      className="w-48"
      defaultValue={value}
      list={`${id}-fonts`}
      pattern="[\p{L}\p{N} ._\-]{0,64}"
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (next !== value && e.currentTarget.validity.valid) onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
    <datalist id={`${id}-fonts`}>
      {fonts.map((font) => (
        <option key={font} value={font} />
      ))}
    </datalist>
  </>
);

const UI_FONTS = [
  "SF Pro Text",
  "Segoe UI",
  "Helvetica Neue",
  "Arial",
  "Ubuntu",
  "Cantarell",
  "Noto Sans",
];
const CODE_FONTS = [
  "SF Mono",
  "Menlo",
  "Consolas",
  "Cascadia Code",
  "Fira Code",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
];

/** A row whose control is one segmented choice, labelled by `prefix + key`. */
const SegmentRow = ({
  id,
  title,
  detail,
  value,
  keys,
  prefix,
  onChange,
}: {
  id: string;
  title: string;
  detail?: string;
  value: string;
  keys: readonly (string | number)[];
  prefix?: string;
  onChange(value: string): void;
}) => {
  const { t } = useTranslation();
  return (
    <SettingRow id={id} title={title} detail={detail}>
      <Segments
        label={title}
        value={value}
        values={keys.map((key) => ({
          value: String(key),
          label: prefix ? t(`${prefix}${key}`) : String(key),
        }))}
        onChange={onChange}
      />
    </SettingRow>
  );
};

/** A pasted or opened theme, or the copy key for why it was refused. */
const readTheme = (
  text: string,
  name: string | undefined,
  size: number
):
  | { ok: true; imported: ReturnType<typeof importVsCodeTheme> }
  | { ok: false; error: "tooLarge" | "notATheme" } => {
  if (size > THEME_FILE_MAX_BYTES) return { ok: false, error: "tooLarge" };
  try {
    return { ok: true, imported: importVsCodeTheme(text, name) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ThemeImportError && error.code === "too-large"
          ? "tooLarge"
          : "notATheme",
    };
  }
};

export const AppearancePage = () => {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const { transport } = useAppContext();
  const look = lookOf(prefs.appearance);
  const systemDark = useMediaQuery(DARK_QUERY);
  const systemHigh = useMediaQuery(CONTRAST_QUERY);
  const high =
    look.contrast === "high" || (look.contrast === "system" && systemHigh);
  const wanted = resolveTheme(prefs.theme, systemDark);
  const current = findTheme(look);
  const [paste, setPaste] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [includeOnly, setIncludeOnly] = useState(false);
  const chrome = useQuery({
    ...windowChromeQuery(transport.orpc),
    enabled: IS_ELECTRON,
  });
  const platform = useQuery(
    transport.orpc.system.info.queryOptions({ input: {} })
  ).data?.platform;
  const fail = () => showError(t("phase5.saveFailed"));
  const setDensity = useMutation(
    transport.orpc.window.setDensity.mutationOptions({
      meta: {
        invalidates: [transport.orpc.window.chrome.queryKey({ input: {} })],
        errorToast: "phase5.saveFailed",
      },
    })
  );
  const save = (patch: Patch) => void update({ appearance: patch }).catch(fail);
  const themes = current.id === "custom" ? [...THEMES, current] : THEMES;
  const a = "settings.appearance.";
  const runImport = (text: string, name?: string, size?: number) => {
    const result = readTheme(text, name, size ?? text.length);
    setIncludeOnly(result.ok && result.imported.includeOnly);
    if (!result.ok) {
      setImportError(t(`${a}${result.error}`));
      return;
    }
    save({ custom: result.imported.theme, palette: "custom" });
    setImportError(null);
    setPaste("");
  };
  return (
    <AreaPage title={t("settings.pages.appearance")}>
      <GroupCard>
        <SettingRow
          id="palette"
          title={t("settings.theme.label")}
          detail={
            current.light && current.dark
              ? undefined
              : t(current.dark ? `${a}forcedDark` : `${a}forcedLight`)
          }
        />
        <Choices
          labelledBy="palette-label"
          value={current.id}
          onChange={(palette) => save({ palette })}
          className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-3"
          options={themes.map((theme) => ({
            value: theme.id,
            label: theme.name,
            className:
              "flex flex-col gap-1.5 rounded-lg p-1 text-start text-xs",
            children: (
              <>
                <ThemePreview
                  theme={theme}
                  mode={wanted}
                  accent={look.accent}
                  high={high}
                />
                <span className="truncate px-0.5 font-medium">
                  {theme.name}
                </span>
              </>
            ),
          }))}
        />
        <SegmentRow
          id="theme"
          title={t(`${a}mode`)}
          detail={t("settings.theme.description")}
          value={prefs.theme}
          keys={["system", "light", "dark"]}
          prefix="theme."
          onChange={(theme) =>
            void update({ theme: theme as PrefsRow["theme"] }).catch(fail)
          }
        />
        <SettingRow id="accent" title={t(`${a}accent`)}>
          <Choices
            labelledBy="accent-label"
            value={look.accent ?? ""}
            onChange={(accent) => save({ accent: accent || null })}
            className="flex flex-wrap items-center gap-1.5"
            options={[
              {
                value: "",
                className: "border-input rounded-md border px-2 py-1 text-xs",
                children: t(`${a}themeAccent`),
              },
              ...ACCENTS.map(([name, color]) => ({
                value: color,
                label: t(`${a}colors.${name}`),
                className: "size-6 rounded-full",
                style: { background: color },
              })),
            ]}
          />
          <input
            key={look.accent}
            type="color"
            aria-label={t(`${a}customAccent`)}
            className="size-7 cursor-pointer rounded-full bg-transparent"
            defaultValue={look.accent ?? ACCENTS[0][1]}
            // The native `change` fires once the picker closes, not per drag.
            ref={(input) => {
              if (!input) return;
              const commit = () => save({ accent: input.value });
              input.addEventListener("change", commit);
              return () => input.removeEventListener("change", commit);
            }}
          />
        </SettingRow>
        <SegmentRow
          id="contrast"
          title={t(`${a}contrast`)}
          value={look.contrast}
          keys={["system", "standard", "high"]}
          prefix={a}
          onChange={(contrast) =>
            save({ contrast: contrast as Patch["contrast"] })
          }
        />
        <SegmentRow
          id="radius"
          title={t(`${a}radius`)}
          value={look.radius}
          keys={["sharp", "default", "round"]}
          prefix={a}
          onChange={(radius) => save({ radius: radius as Patch["radius"] })}
        />
        {IS_ELECTRON && (
          <SegmentRow
            id="density"
            title={t("phase5.settings.density")}
            detail={
              platform === "darwin"
                ? t("phase5.settings.densityDetail")
                : undefined
            }
            value={chrome.data?.density ?? "comfortable"}
            keys={["comfortable", "compact"]}
            prefix="phase5."
            onChange={(density) =>
              setDensity.mutate({
                density: density as "comfortable" | "compact",
              })
            }
          />
        )}
        {WINDOW_TRANSLUCENCY &&
          (platform === "darwin" || platform === "win32") && (
            <SettingRow id="translucency" title={t(`${a}translucency`)}>
              <SettingSwitch
                id="translucency"
                checked={look.translucency}
                onCheckedChange={(translucency) => save({ translucency })}
              />
            </SettingRow>
          )}
        <SettingRow
          id="allowTwoTabRows"
          title={t(`${a}allowTwoTabRows`)}
          detail={t(`${a}allowTwoTabRowsDetail`)}
        >
          <SettingSwitch
            id="allowTwoTabRows"
            checked={look.allowTwoTabRows === true}
            onCheckedChange={(allowTwoTabRows) => save({ allowTwoTabRows })}
          />
        </SettingRow>
        <SettingRow
          id="railIconsOnly"
          title={t(`${a}railIconsOnly`)}
          detail={t(`${a}railIconsOnlyDetail`)}
        >
          <SettingSwitch
            id="railIconsOnly"
            checked={look.railIconsOnly}
            onCheckedChange={(railIconsOnly) => save({ railIconsOnly })}
          />
        </SettingRow>
      </GroupCard>
      <GroupCard>
        <SegmentRow
          id="textSize"
          title={t("phase5.settings.textSize")}
          value={String(look.textSize)}
          keys={[13, 14, 15]}
          onChange={(size) => save({ textSize: Number(size) as 13 | 14 | 15 })}
        />
        {(["uiFont", "codeFont"] as const).map((id) => (
          <SettingRow
            key={id}
            id={id}
            title={t(`${a}${id}`)}
            detail={t(`${a}fontDetail`)}
          >
            <FontInput
              id={id}
              value={look[id]}
              fonts={id === "uiFont" ? UI_FONTS : CODE_FONTS}
              onSave={(font) => save({ [id]: font })}
            />
          </SettingRow>
        ))}
        <SegmentRow
          id="codeSize"
          title={t(`${a}codeSize`)}
          value={String(look.codeFontSize)}
          keys={[11, 12, 13, 14, 15, 16]}
          onChange={(size) => save({ codeFontSize: Number(size) })}
        />
        <SegmentRow
          id="reduceMotion"
          title={t("phase5.settings.reduceMotion")}
          value={prefs.motion.reduce}
          keys={["system", "on", "off"]}
          prefix="phase5."
          onChange={(reduce) =>
            void update({
              motion: { reduce: reduce as "system" | "on" | "off" },
            }).catch(fail)
          }
        />
        <SettingRow id="bubbleTint" title={t("phase5.settings.bubbleTint")}>
          <SettingSwitch
            id="bubbleTint"
            checked={look.bubbleTint}
            onCheckedChange={(bubbleTint) => save({ bubbleTint })}
          />
        </SettingRow>
      </GroupCard>
      <GroupCard>
        <SettingRow id="importTheme" title={t(`${a}importTheme`)}>
          {look.custom && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                save({
                  custom: null,
                  ...(look.palette === "custom" ? { palette: "default" } : {}),
                })
              }
            >
              {t(`${a}remove`)}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void pickThemeFile(transport.client)
                .then(
                  (file) => file && runImport(file.text, file.name, file.size)
                )
                .catch(fail)
            }
          >
            {t(`${a}openFile`)}
          </Button>
        </SettingRow>
        <Collapsible>
          <CollapsibleTrigger
            render={<Button size="sm" variant="ghost" className="m-2" />}
          >
            {t(`${a}pasteLabel`)}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 px-3 pb-3">
            <Textarea
              aria-label={t(`${a}pasteLabel`)}
              rows={5}
              className="font-mono text-xs"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!paste.trim()}
              onClick={() => runImport(paste)}
            >
              {t(`${a}import`)}
            </Button>
          </CollapsibleContent>
        </Collapsible>
        {importError && (
          <p role="alert" className="text-destructive px-3 pb-3 text-xs">
            {importError}
          </p>
        )}
        {includeOnly && (
          <p role="status" className="text-muted-foreground px-3 pb-3 text-xs">
            {t(`${a}includeHint`)}
          </p>
        )}
      </GroupCard>
    </AreaPage>
  );
};
