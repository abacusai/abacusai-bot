/**
 * Every button in the message box has a `bot_help` entry. Asked how to
 * dictate, the model described a microphone from memory and got it wrong:
 * the help had no word on the message box. A button added here without an
 * entry in BOT_HELP_CONTROLS fails this test instead of a user's question.
 */
import { BOT_HELP_CONTROLS } from "@abacus-ai/contract/bot-help";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderScenario } from "../testing";

let current: { cleanup(): Promise<void> } | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

/** A control is known by its picker's slot, or by a label it shows. */
const known = new Set(
  BOT_HELP_CONTROLS.flatMap((control) => [
    ...(control.slot != null ? [control.slot] : []),
    control.label.text,
    ...(control.states ?? []).map((state) => state.text),
  ])
);

const model = {
  value: "abacus/flash",
  label: "Flash",
  onChange: () => {},
  groups: [],
};

/** Each button in the message box, by the slot or name `known` holds it under. */
const controls = async (): Promise<string[]> => {
  const box = document.querySelector('[data-slot="composer"]') as HTMLElement;
  // Focused, the pill opens into the box with every control.
  await act(async () => box.querySelector("textarea")?.focus());
  return [...box.querySelectorAll("button, [role=combobox]")].map((element) => {
    const slot = element.getAttribute("data-slot") ?? "";
    return known.has(slot)
      ? slot
      : (element.getAttribute("aria-label") ?? element.textContent ?? "");
  });
};

describe("the message box's buttons", () => {
  it.each(["session-running", "session-new", "composer-dictating", "bot-chat"])(
    "each has a bot_help entry: %s",
    async (scenario) => {
      current = await renderScenario(scenario, { composer: { model } });
      const found = await controls();
      expect(found.length).toBeGreaterThan(0);
      for (const name of found) expect(known, name).toContain(name);
    }
  );

  it("include the microphone, the model menu and Send", async () => {
    current = await renderScenario("session-new", { composer: { model } });
    expect(await controls()).toEqual(
      expect.arrayContaining(["Dictate", "chat-model-picker", "Attach"])
    );
  });
});
