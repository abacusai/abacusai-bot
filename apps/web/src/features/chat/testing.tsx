import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider } from "@tanstack/react-router";
/**
 * Test helpers for the chat kit (tests only): render a node inside the
 * fixture DB (prefs drive the motion preference) with English copy, and
 * mount a scenario's `ChatView` over the fixture relay.
 */
import { act, render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";

import { DbProvider } from "#renderer/data/db";
import { clearDraft } from "#renderer/lib/continuity/composer-drafts";
import { i18n, initI18n } from "#renderer/lib/i18n";
import { createHarness } from "#renderer/test-support/app-harness";

import {
  fixtureRuntime,
  type FixtureRuntime,
  type PlayOptions,
} from "./fixtures/player";
import type { FakeRelay } from "./fixtures/relay";
import type { ComposerConfig, ChatViewSlots } from "./kit/context";
import { ChatView } from "./kit/view";
import { inertHostActions, type ChatHostActions } from "./runtime/host-actions";
import { createChatRuntime, type ChatRuntime } from "./runtime/runtime";

export interface Rendered {
  view: RenderResult;
  /** Render another node in the same providers (same db, same runtime). */
  rerender(node: ReactNode): Promise<void>;
  cleanup(): Promise<void>;
}

export const renderWithDb = async (node: ReactNode): Promise<Rendered> => {
  await initI18n();
  await i18n.changeLanguage("en-US");
  const os = implement(contract);
  const harness = await createHarness("/", {
    procedures: { links: { preview: os.links.preview.handler(() => null) } },
  });
  const db = harness.appDb;
  const queryClient = harness.router.options.context.queryClient;
  const wrap = (child: ReactNode) => (
    <HotkeysProvider
      defaultOptions={{
        hotkey: {
          platform: "mac",
          preventDefault: false,
          stopPropagation: false,
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <RouterContextProvider router={harness.router}>
          <DbProvider value={db}>{child}</DbProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    </HotkeysProvider>
  );
  let view!: RenderResult;
  await act(async () => {
    view = render(wrap(node));
  });
  return {
    view,
    rerender: async (next) => {
      await act(async () => {
        view.rerender(wrap(next));
      });
    },
    cleanup: async () => {
      view.unmount();
      await harness.cleanup();
    },
  };
};

const baseComposer = (
  skin: "bot" | "session",
  extra: Partial<ComposerConfig> = {}
): ComposerConfig => ({
  mode: "full",
  placeholder:
    skin === "bot"
      ? "Message Chief of Staff"
      : "Steer the run, or queue the next step",
  attachmentsBase: skin === "session" ? "/repo" : null,
  showModeChip: skin === "session",
  model: null,
  ...extra,
});

export const renderScenario = async (
  scenarioId: string,
  options: PlayOptions & {
    composer?: Partial<ComposerConfig>;
    onOpenFile?: (path: string) => void;
    onOpenSubagent?: (id: string) => void;
  } = {}
): Promise<Rendered & { fixture: FixtureRuntime }> => {
  const fixture = fixtureRuntime(scenarioId, options)!;
  const skin = fixture.scenario.skin;
  await fixture.runtime.session(fixture.threadId).load();
  const rendered = await renderWithDb(
    <div style={{ height: 800 }}>
      <ChatView
        threadId={fixture.threadId}
        skin={skin}
        runtime={fixture.runtime}
        workspaceRoot={skin === "session" ? "/repo" : null}
        composer={baseComposer(skin, {
          dictating: fixture.scenario.view?.dictating === true,
          ...options.composer,
        })}
        {...(options.onOpenFile != null
          ? { onOpenFile: options.onOpenFile }
          : {})}
        {...(options.onOpenSubagent != null
          ? { onOpenSubagent: options.onOpenSubagent }
          : {})}
      />
    </div>
  );
  return {
    ...rendered,
    fixture,
    cleanup: async () => {
      await rendered.cleanup();
      fixture.runtime.forget(fixture.threadId);
      clearDraft(fixture.threadId);
    },
  };
};

/** A `ChatView` over any relay (tests that build their own log or history). */
export const renderRelay = async (
  relay: FakeRelay,
  skin: "bot" | "session",
  composer: Partial<ComposerConfig> = {},
  viewOptions: { focused?: boolean; slots?: ChatViewSlots } = {},
  host: ChatHostActions = inertHostActions
): Promise<Rendered & { runtime: ChatRuntime; remount(): Promise<void> }> => {
  const runtime = createChatRuntime(relay.ai, { host });
  await runtime.session(relay.threadId).load();
  let mount = 0;
  const tree = () => (
    <div style={{ height: 800 }}>
      <ChatView
        key={mount}
        threadId={relay.threadId}
        skin={skin}
        runtime={runtime}
        workspaceRoot={skin === "session" ? "/repo" : null}
        composer={baseComposer(skin, composer)}
        {...viewOptions}
      />
    </div>
  );
  const rendered = await renderWithDb(tree());
  return {
    ...rendered,
    runtime,
    /** A fresh `ChatView` over the same runtime: a route re-entering the thread. */
    remount: async () => {
      mount += 1;
      await rendered.rerender(tree());
    },
    cleanup: async () => {
      await rendered.cleanup();
      runtime.forget(relay.threadId);
    },
  };
};
