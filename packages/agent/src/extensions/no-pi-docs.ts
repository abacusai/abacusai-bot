/**
 * pi's default system prompt ends with a section pointing the model at pi's
 * own documentation — `docs/skills.md`, `docs/extensions.md`, its TUI and
 * SDK — resolved beside the agent bundle. None of it ships with this app, and
 * none of it is about this app: a user asking how skills work sent the model
 * to read a file that does not exist. The section is cut per turn; the rest
 * of pi's prompt, and everything appended to it, is untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** From the section's heading through its last bullet, with the blank lines before it. */
const PI_DOCS_SECTION =
  /\n*Pi documentation \(read only when the user asks about pi itself[^\n]*\n(?:- [^\n]*\n?)*/u;

export const withoutPiDocs = (systemPrompt: string): string =>
  systemPrompt.replace(PI_DOCS_SECTION, "\n");

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const trimmed = withoutPiDocs(event.systemPrompt);

    return trimmed === event.systemPrompt
      ? undefined
      : { systemPrompt: trimmed };
  });
}
