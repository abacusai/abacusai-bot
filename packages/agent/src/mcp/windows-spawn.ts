/**
 * Spawning a user-configured stdio MCP server on Windows. `npx`/`uvx` are
 * `.cmd` shims Node refuses to spawn directly (CVE-2024-27980), so they go
 * through cmd.exe, which re-parses the line: tokens are resolved and quoted
 * here. PATH/PATHEXT resolution compares case-folded directory entries so it
 * is testable off Windows.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * One cmd.exe token. Only ever quote an ABSOLUTE path as the command: a batch
 * file resolves `%~dp0` from the invoking text, and a quoted bare "npx.cmd"
 * makes that the cwd, so npm's shim looks for node_modules in the wrong place.
 */
const quote = (token: string): string => {
  // The child's argv parser halves a backslash run that meets a quote, so
  // every run against a quote (embedded or our closing one) is doubled.
  const escaped = token.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1");

  return `"${escaped}"`;
};

/** The command line for `cmd.exe /d /s /c` — every token quoted. */
export const cmdCommandLine = (
  absoluteCommand: string,
  args: readonly string[]
): string => [absoluteCommand, ...args].map(quote).join(" ");

/** Case-folded entry lookup, so resolution matches Windows' own. */
const findEntry = (dir: string, wanted: string): string | null => {
  let entries: string[];

  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const lowered = wanted.toLowerCase();

  return entries.find((e) => e.toLowerCase() === lowered) ?? null;
};

/**
 * Resolve a command the way cmd.exe would: each PATH directory, each PATHEXT
 * extension. Only names already carrying an executable extension are tried
 * verbatim: npm installs an extensionless POSIX `npx` script beside `npx.cmd`,
 * and preferring the exact name would pick one Windows cannot run (error 193).
 */
export const resolveWin32Command = (
  command: string,
  pathValue: string,
  pathExtValue: string
): string | null => {
  const exts = pathExtValue
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e !== "");

  // A command given as a path skips the PATH walk, like the shell.
  const hasSep = command.includes("/") || command.includes("\\");
  const name = hasSep ? path.basename(command) : command;
  const dirs = hasSep
    ? [path.dirname(path.resolve(command))]
    : pathValue.split(";").filter((d) => d.trim() !== "");

  const loweredName = name.toLowerCase();
  const namedExecutable = exts.some((ext) =>
    loweredName.endsWith(ext.toLowerCase())
  );
  const candidates = namedExecutable
    ? [name, ...exts.map((ext) => name + ext)]
    : exts.map((ext) => name + ext);

  for (const dir of dirs) {
    for (const wanted of candidates) {
      const found = findEntry(dir, wanted);

      if (found == null) continue;

      const full = path.join(dir, found);

      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* raced away — keep looking */
      }
    }
  }

  return null;
};

/**
 * Resolve `%NAME%` in arguments before cmd.exe does: cmd expands it even
 * inside quotes, so substituting here leaves it nothing to act on. Refuse only
 * a value that itself contains `%`; an undefined name stays literal, as in cmd.
 */
const expand = (args: readonly string[], env: NodeJS.ProcessEnv): string[] => {
  const byLowerName = new Map(
    Object.entries(env).map(([key, value]) => [key.toLowerCase(), value])
  );

  return args.map((arg) =>
    arg.replace(/%([^%\s=]+)%/g, (literal, name: string) => {
      const value = byLowerName.get(name.toLowerCase());

      if (value == null) return literal;

      if (value.includes("%")) {
        throw new Error(
          `MCP server argument ${JSON.stringify(arg)} contains %${name}%, ` +
            "whose value itself contains a '%' that cmd.exe would expand " +
            "again. Remove it or rename the variable."
        );
      }

      return value;
    })
  );
};

export interface SpawnSpec {
  file: string;
  args: string[];
  /** Set when `args` is a pre-built cmd line that Node must not re-quote. */
  windowsVerbatimArguments?: boolean;
}

/**
 * What to actually spawn. Only .cmd/.bat get the cmd.exe wrapper; an
 * unresolved command passes through so the spawn reports ENOENT.
 */
export const resolveSpawn = (
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): SpawnSpec => {
  if (platform !== "win32") return { file: command, args: [...args] };

  const resolved = resolveWin32Command(
    command,
    env.PATH ?? env.Path ?? "",
    env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"
  );

  if (resolved == null || !/\.(cmd|bat)$/i.test(resolved)) {
    return { file: resolved ?? command, args: [...args] };
  }

  // `/d` skips AutoRun; `/s /c` strips exactly the outer quotes we add.
  return {
    file: "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `"${cmdCommandLine(resolved, expand(args, env))}"`,
    ],
    windowsVerbatimArguments: true,
  };
};
