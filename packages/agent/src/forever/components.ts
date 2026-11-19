import {
  type ExtensionAPI,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { buildDeckTool } from "../deck-tool.js";
import { buildDocumentTool } from "../document-tool.js";
import pdfRoute from "../extensions/pdf-route.js";
import type { HostServiceClient } from "../host-services.js";
import type { AgentEvent } from "../protocol.js";
import { type RosterContext, subAgentOptions } from "../roster.js";

/**
 * The document and deck tools for a bot chat, wired as the desktop chat wires
 * them: each run reads the chat's model when it starts, and sub-agents get
 * their own settings manager. No skills: a bot's chat loads none either.
 */
export const botComponentTools = (
  components: readonly string[],
  ctx: Pick<RosterContext, "cwd" | "agentDir" | "modelRuntime" | "model"> & {
    hostServices: HostServiceClient;
    requestSources?: RosterContext["requestSources"];
  },
  emit: (event: AgentEvent) => void
): unknown[] => {
  const options = subAgentOptions(
    {
      ...ctx,
      subAgentSettingsManager: SettingsManager.create(ctx.cwd, ctx.agentDir),
    },
    {
      hostServices: ctx.hostServices,
      skillPaths: [],
    }
  );
  return [
    ...(components.includes("document")
      ? [buildDocumentTool(options, emit)]
      : []),
    ...(components.includes("ppt") ? [buildDeckTool(options, emit)] : []),
  ];
};

/**
 * The guards that go with the components: where the bot has `document`, a
 * PDF built by hand is blocked as in the desktop chat (final round: a bot
 * made its cover with reportlab and re-printed a page with Chrome).
 */
export const botComponentExtensions = (
  components: readonly string[]
): Array<{ name: string; factory: (pi: ExtensionAPI) => void }> =>
  components.includes("document") || components.includes("ppt")
    ? [
        {
          name: "abacusai-bot-pdf-route",
          factory: pdfRoute({
            ...(components.includes("document")
              ? { document: "document" }
              : {}),
            ...(components.includes("ppt") ? { ppt: "ppt" } : {}),
          }),
        },
      ]
    : [];
