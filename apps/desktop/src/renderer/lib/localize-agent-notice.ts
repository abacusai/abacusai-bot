import i18n from "../i18n";

/** Translate known application diagnostics; leave provider details untouched. */
export function localizeAgentNotice(message: string): string {
  if (
    message === "No model provider is configured. Add an API key in Settings."
  ) {
    return i18n.t("uiText.noModelProvider");
  }
  return message;
}
