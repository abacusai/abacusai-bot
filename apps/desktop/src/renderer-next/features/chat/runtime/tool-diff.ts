import { parsePartialJSON } from "@tanstack/ai-client";
import type {
  ToolCallPart,
  ToolResultPart,
  UIMessage,
} from "@tanstack/ai-client";

import { normalizeTool, toolInput } from "../kit/tools/normalize";
import { toolKey } from "../store/thread-store";
import type { ThreadSession } from "./session";
export type ToolDiffResult =
  | { state: "ready"; filePath: string; original: string; final: string }
  | { state: "unavailable"; reason: "not-in-history" | "no-diff" };
export const resolveSessionToolDiff = async (
  session: ThreadSession,
  key: string
): Promise<ToolDiffResult> => {
  await session.load();
  for (let page = 0; page <= 10; page++) {
    const groups: Array<{ scope: string | undefined; messages: UIMessage[] }> =
      [
        { scope: undefined, messages: session.hostStore.state.messages },
        ...session.hostStore.state.subagents.map((s) => ({
          scope: s.id,
          messages: s.messages,
        })),
      ];
    for (const group of groups)
      for (const message of group.messages) {
        const call = message.parts.find(
          (p): p is ToolCallPart =>
            p.type === "tool-call" && toolKey(group.scope, p.id) === key
        );
        if (!call) continue;
        const result = group.messages
          .flatMap((m) => m.parts)
          .find(
            (p): p is ToolResultPart =>
              p.type === "tool-result" && p.toolCallId === call.id
          );
        const stableKey = toolKey(group.scope, call.id);
        const live = {
          output: session.store.state.tools.output[stableKey],
          display: session.store.state.tools.display[stableKey],
        };
        const tool = normalizeTool(
          call,
          result,
          live,
          { runActive: false },
          parsePartialJSON
        );
        const input = toolInput(call, parsePartialJSON);
        return tool.diff
          ? {
              state: "ready",
              filePath: String(input.path ?? input.file_path ?? ""),
              original: tool.diff.original ?? "",
              final: tool.diff.final ?? "",
            }
          : { state: "unavailable", reason: "no-diff" };
      }
    if (!session.hostStore.state.hasOlderMessages || page === 10) break;
    await session.loadOlder();
  }
  return { state: "unavailable", reason: "not-in-history" };
};
