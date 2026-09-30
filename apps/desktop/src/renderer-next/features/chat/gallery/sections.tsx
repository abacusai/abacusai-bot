/**
 * The chat's `/__ui` gallery entries (spec 02 §11.2): every scenario, by
 * section, replayed through the real runtime over the fixture relay
 * (`?fixture=<id>&step=<n>&play=1`). Dev-only, English-only.
 */
import { useNavigate } from "@tanstack/react-router";
import { useState, type CSSProperties } from "react";

import { botAccentStyle } from "#next/lib/theme";
import { BOT_AVATAR_COLORS } from "#shared/bots";

import type { ComposerConfig } from "../kit/context";
import { ChatView } from "../kit/view";
import { fixtureRuntime } from "../fixtures/player";
import { SCENARIOS, type Scenario } from "../fixtures/scenarios";

export const GALLERY_GROUPS: Array<{ id: string; match: (scenario: Scenario) => boolean }> = [
  { id: "chat-transcript", match: (s) => s.id.startsWith("bot-") || s.id === "session-review" || s.id === "session-migrated" },
  { id: "chat-tools", match: (s) => ["session-running", "session-golden-tool-bash", "session-golden-plan"].includes(s.id) },
  { id: "chat-permissions", match: (s) => (s.id.startsWith("perm-") && s.id !== "perm-question") || s.id === "session-sandbox-refused" || s.id === "session-browser" || s.id === "session-golden-permission" },
  { id: "chat-questions", match: (s) => s.id === "perm-question" },
  { id: "chat-subagents", match: (s) => s.id === "session-subagents" || s.id === "session-golden-delegates" },
  { id: "chat-composer", match: (s) => s.id.startsWith("composer-") || s.id.startsWith("readonly-") || s.id.startsWith("session-mini") || s.id === "session-new" || s.id === "session-split" || s.id === "session-workspace-missing" || s.id === "session-golden-steer" },
  { id: "chat-errors", match: (s) => s.id === "session-failed-ratelimit" || s.id === "session-golden-turn-failed" },
];

const Nav = ({ fixture }: { fixture: string | undefined }) => {
  const navigate = useNavigate();
  const open = (id: string | undefined) =>
    void navigate({
      to: "/__ui",
      search: (previous: Record<string, unknown>) => ({ ...previous, fixture: id, step: undefined, play: undefined }),
      replace: true,
    } as never);
  return (
    <div className="mt-4 flex flex-col gap-2 text-xs" data-slot="chat-gallery-nav">
      {GALLERY_GROUPS.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          <div className="px-2 pt-1 font-medium text-muted-foreground">{group.id}</div>
          {SCENARIOS.filter(group.match).map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              aria-current={fixture === scenario.id ? "true" : undefined}
              className="w-full rounded px-2 py-1 text-left hover:bg-muted aria-[current=true]:bg-muted"
              onClick={() => open(scenario.id)}
            >
              {scenario.id}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
};

const MODEL_GROUPS = [
  {
    id: "favourites",
    label: "Favourites",
    items: [
      { id: "route-llm", label: "RouteLLM", description: "Abacus.AI" },
      { id: "claude-sonnet", label: "Claude Sonnet", description: "Anthropic" },
    ],
  },
  { id: "openrouter", label: "OpenRouter", items: [], connect: { label: "Connect OpenRouter", onSelect: () => {} } },
];

const composerFor = (scenario: Scenario, model: { value: string | null; set(id: string | null): void }): ComposerConfig => ({
  mode: scenario.id.startsWith("session-mini") ? "mini" : "full",
  placeholder: scenario.view?.placeholder ?? (scenario.skin === "bot" ? "Message Chief of Staff" : "Steer the run, or queue the next step"),
  attachmentsBase: scenario.skin === "session" ? "/Users/me/code/abacusai-bot" : null,
  showModeChip: scenario.skin === "session",
  model:
    scenario.view?.model != null
      ? {
          value: model.value,
          label: MODEL_GROUPS[0]!.items.find((item) => item.id === model.value)?.label ?? scenario.view.model,
          onChange: model.set,
          groups: MODEL_GROUPS,
        }
      : null,
  ...(scenario.view?.readOnly != null ? { readOnly: { reason: scenario.view.readOnly } } : {}),
  ...(scenario.view?.preStart === true ? { preStart: true } : {}),
  mentions: {
    search: async (query) =>
      ["components/layout/workspace-view.tsx", "components/layout/workspace-sidebar.tsx", "components/layout/workspace-view.shell.test.tsx"].filter(
        (path) => path.includes(query)
      ),
  },
});

const View = ({ fixture, step, play }: { fixture: string; step: number | undefined; play: boolean }) => {
  const [runtime] = useState(() => fixtureRuntime(fixture, { ...(step != null ? { step } : {}), play }));
  const [model, setModel] = useState<string | null>("route-llm");
  if (runtime == null) return <p className="py-6 text-sm">{`No scenario ${fixture}`}</p>;
  const { scenario } = runtime;
  return (
    <div className="flex flex-col gap-3 py-6" data-scenario={scenario.id}>
      <div className="flex items-baseline gap-3 text-sm">
        <h1 className="font-semibold">{scenario.id}</h1>
        <span className="text-xs text-muted-foreground">{scenario.canvas.join(", ")}</span>
      </div>
      <div
        className="h-[720px] overflow-hidden rounded-xl border bg-background"
        style={scenario.skin === "bot" ? (botAccentStyle(BOT_AVATAR_COLORS[0]!) as CSSProperties) : undefined}
      >
        <ChatView
          threadId={runtime.threadId}
          skin={scenario.skin}
          runtime={runtime.runtime}
          workspaceRoot={scenario.skin === "session" ? "/Users/me/code/abacusai-bot" : null}
          composer={composerFor(scenario, { value: model, set: setModel })}
          onOpenSubagent={() => {}}
          notchEnabled={scenario.skin === "bot"}
        />
      </div>
    </div>
  );
};

export const chatGallerySections = { Nav, View };
