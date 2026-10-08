import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  clearDraft,
  draftRevision,
  draftStore,
  updateDraft,
} from "#renderer/lib/continuity/composer-drafts";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { adoptDraftModel } from "../index";
import { renderRelay } from "../testing";

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
  clearDraft("start");
});
const field = () =>
  within(
    document.querySelector('[data-slot="composer"]') as HTMLElement
  ).getByRole("textbox");
const disk = [
  { id: "disk", name: "disk", description: "Disk command", location: "" },
];

it("adopts a model into only the named draft, preserving content and mode", () => {
  updateDraft("start", () => ({
    text: "keep",
    attachments: [],
    mode: "PLAN" as never,
  }));
  const revision = draftRevision("start");
  adoptDraftModel("start", "local/test");
  expect(draftStore.state.start).toEqual({
    text: "keep",
    attachments: [],
    mode: "PLAN",
    model: "local/test",
  });
  expect(draftRevision("start")).toBe(revision + 1);
  expect(draftStore.state["t-1"]?.model).toBeUndefined();
  adoptDraftModel("start", null);
  expect(draftStore.state.start?.model).toBeNull();
});

it.each([false, true])(
  "uses disk skills when live skills are absent or empty (%s)",
  async (emitEmpty) => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      ...(emitEmpty ? [b.custom("skills.loaded", { skills: [] })] : []),
    ]);
    current = await renderRelay(relay, "session", { skillsBaseline: disk });
    fireEvent.change(field(), { target: { value: "/", selectionStart: 1 } });
    fireEvent.click(await screen.findByRole("option", { name: /\/disk/ }));
    expect((field() as HTMLTextAreaElement).value).toBe("/disk ");
  }
);

it("prefers nonempty live skills over disk skills", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.custom("skills.loaded", {
      skills: [
        { id: "live", name: "live", description: "Live command", location: "" },
      ],
    }),
  ]);
  current = await renderRelay(relay, "session", { skillsBaseline: disk });
  fireEvent.change(field(), { target: { value: "/", selectionStart: 1 } });
  expect(await screen.findByRole("option", { name: /\/live/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /\/disk/ })).toBeNull();
});

it("calls the route's local-model action from the picker", async () => {
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  const onUseLocalModel = vi.fn();
  const onChange = vi.fn();
  current = await renderRelay(relay, "session", {
    onUseLocalModel,
    model: { value: null, label: "Default", groups: [], onChange },
  });
  fireEvent.click(document.querySelector('[data-slot="chat-model-picker"]')!);
  fireEvent.click(
    await screen.findByRole("option", { name: "Use a local model" })
  );
  expect(onUseLocalModel).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
});

it("calls the route's local-model action from the upgrade card", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("r-1"),
    b.runError("r-1", {
      message: "Credits exhausted",
      actions: [{ type: "upgrade-abacus" }],
    }),
  ]);
  const onUseLocalModel = vi.fn();
  current = await renderRelay(relay, "session", { onUseLocalModel });
  fireEvent.click(
    await screen.findByRole("button", { name: "Use a local model" })
  );
  expect(onUseLocalModel).toHaveBeenCalledOnce();
});
