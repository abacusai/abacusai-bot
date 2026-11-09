/**
 * A child's environment. On Windows a plain copy of `process.env` keeps `Path`, so
 * `env.PATH` misses it; here each name appears once and the path one is `PATH`.
 */

/**
 * Names the app's own Python environment when the desktop put it first on the
 * agent's PATH, because the machine has no usable Python of its own.
 */
export const MANAGED_PYTHON_ENV = "ABACUSAI_BOT_PYTHON_ENV";

/**
 * Set only for this app's own Node runs, never for what a user starts: an
 * inherited ELECTRON_RUN_AS_NODE turns any Electron app (LM Studio, VS Code,
 * Slack) into plain Node, and ELECTRON_NO_ATTACH_CONSOLE silences one on Windows.
 * Dropped from every base; a caller running the app's binary as Node passes it
 * back as an override.
 */
export const ELECTRON_INTERNAL_ENV: readonly string[] = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
];

/** Variables laid over the base; an `undefined` value removes one, as a spread would. */
export type EnvOverrides = Readonly<Record<string, string | undefined>>;

/**
 * `base` (this process's environment by default) without ELECTRON_INTERNAL_ENV,
 * with `overrides` applied in order.
 */
export function childProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  ...overrides: Array<EnvOverrides | undefined>
): Record<string, string> {
  return childProcessEnvFor(process.platform, base, ...overrides);
}

/** `childProcessEnv` for a given platform, so the Windows rules can be tested anywhere. */
export function childProcessEnvFor(
  platform: NodeJS.Platform,
  base: NodeJS.ProcessEnv,
  ...overrides: Array<EnvOverrides | undefined>
): Record<string, string> {
  const env: Record<string, string> = {};

  if (platform !== "win32") {
    for (const [key, value] of Object.entries(base))
      if (typeof value === "string" && !ELECTRON_INTERNAL_ENV.includes(key))
        env[key] = value;
    for (const layer of overrides)
      for (const [key, value] of Object.entries(layer ?? {}))
        if (typeof value === "string") env[key] = value;
        else delete env[key];

    return env;
  }

  // Upper-cased name to the spelling it is stored under.
  const names = new Map<string, string>();
  const put = (key: string, value: string | undefined): void => {
    const folded = key.toUpperCase();
    const name = folded === "PATH" ? "PATH" : (names.get(folded) ?? key);

    if (value === undefined) {
      delete env[name];
      names.delete(folded);
    } else {
      env[name] = value;
      names.set(folded, name);
    }
  };

  // Within the base, the spelling spawn itself would keep: first in sorted order.
  for (const key of Object.keys(base).sort()) {
    const value = base[key];
    const folded = key.toUpperCase();
    if (
      typeof value === "string" &&
      !names.has(folded) &&
      !ELECTRON_INTERNAL_ENV.includes(folded)
    )
      put(key, value);
  }
  for (const layer of overrides)
    for (const [key, value] of Object.entries(layer ?? {}))
      put(key, typeof value === "string" ? value : undefined);
  // Python's stdio otherwise uses the console code page and fails on non-ASCII output.
  // Not PYTHONUTF8: that also changes how scripts read files.
  if (!names.has("PYTHONIOENCODING")) put("PYTHONIOENCODING", "utf-8");

  return env;
}
