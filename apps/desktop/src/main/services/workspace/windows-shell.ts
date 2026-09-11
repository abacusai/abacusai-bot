/**
 * Running a Windows batch file without the shell eating the arguments. Node
 * cannot spawn `.bat`/`.cmd` directly, so those calls need `shell: true`, which
 * joins command and arguments into one string for cmd to re-parse. Android SDK
 * package ids contain `;` and the SDK path usually contains a space, so every
 * token is quoted and handed over as a single command string.
 */

/** One token, quoted so a shell hands it back whole. */
const quote = (token: string): string => `"${token.replace(/"/g, '""')}"`;

/**
 * Every token is quoted, including the executable: it is the one most likely
 * to contain a space and only fails on machines whose user name has one.
 */
export const shellCommandLine = (
  file: string,
  args: readonly string[]
): string => [file, ...args].map(quote).join(" ");
