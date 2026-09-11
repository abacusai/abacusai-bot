import * as path from "node:path";

/**
 * Turning a failed `read` into the call the model meant to make. EISDIR is a
 * model that wanted `ls`; ENOENT is one guessing file names instead of
 * listing. Both errors get the next call appended. Lives here, not in the
 * system prompt, so only the sessions that make the mistake pay for it. The
 * raw error stays and `isError` stays true: a repair reporting success would
 * be lying to the loop.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The text of a result, however many blocks it arrived in. */
function resultText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" || !event.isError) return;

    const text = resultText(
      event.content as Array<{ type: string; text?: string }>
    );
    const target =
      typeof (event.input as { path?: unknown }).path === "string"
        ? (event.input as { path: string }).path
        : undefined;

    if (text.includes("EISDIR")) {
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text:
              `${target ?? "That path"} is a directory, not a file. ` +
              "Use `ls` on it to see what is inside, then read a file by name. " +
              "`glob` finds files by pattern across subdirectories, and `grep` searches their contents.",
          },
        ],
      };
    }

    // A guessed path: name the parent directory, which is what to list next.
    if (text.includes("ENOENT") && target != null) {
      const parent = path.dirname(target);

      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text:
              `There is no file at ${target}. Do not try another name from memory — ` +
              `run \`ls\` on ${parent === "." ? "the directory" : parent} and read one that is ` +
              "actually listed, or use `glob` if you are not sure which directory it is in.",
          },
        ],
      };
    }

    return;
  });
}
