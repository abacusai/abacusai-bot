/**
 * The ABACUSAI_BOT_EXCLUDED_TOOLS value for a spawning agent: the tools the
 * Capabilities settings switch off, plus any list already set where the app
 * was launched, so a launch-time switch is added to rather than overwritten.
 */
export const excludedToolsEnv = (
  fromSettings: readonly string[],
  inherited: string | undefined
): string | null => {
  const names = [...fromSettings, ...(inherited ?? "").split(",")]
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unique = [...new Set(names)];

  return unique.length > 0 ? unique.join(",") : null;
};
