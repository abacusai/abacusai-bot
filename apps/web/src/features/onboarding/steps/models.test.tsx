/**
 * The models slide (canvas OnboardModels, OnboardKeyDialog): the three
 * provider rows with the connected rule, OpenRouter's hop, Gemini's "Add
 * API key" opening the key dialog directly, "Paste a key" picking any model
 * provider, "Connect later" and Continue both advancing.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { fixedT, initI18n } from "#renderer/lib/i18n";

import type { StepContext } from "./context";
import { ModelsStep } from "./models";

const ctx = (signedIn: boolean) => {
  const start = vi.fn(async () => ({ ok: true }));
  const props = {
    step: "models",
    transport: { client: { auth: { openRouter: { start } } } } as never,
    facts: { signedIn, payingTier: false, ownsBot: false },
    navigate: vi.fn(async () => {}),
    signIn: vi.fn(),
    cancelSignIn: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    createFirstBot: vi.fn(),
    localModel: (
      <div className="onboarding-row" data-slot="local-model-row">
        local
      </div>
    ),
  } as StepContext["props"];
  const context: StepContext = {
    props,
    t: fixedT(),
    busy: false,
    perform: async (action) => {
      await action();
    },
    advance: vi.fn(),
    back: vi.fn(),
  };
  return { context, start };
};

describe("ModelsStep", () => {
  it("marks Abacus connected when signed in, OpenRouter from the connected rule, and hops for OpenRouter", async () => {
    await initI18n();
    const { context, start } = ctx(true);
    const refresh = vi.fn(async () => {});
    const { container } = render(
      <ModelsStep
        ctx={context}
        connected={new Set()}
        refresh={refresh}
        heading={createRef()}
      />
    );
    const rows = [...container.querySelectorAll(".onboarding-row")];
    expect(rows.map((row) => row.getAttribute("data-connected"))).toEqual([
      "true",
      "false",
      "false",
      null,
    ]);
    expect(rows[0]!.textContent).toContain("Connected");
    expect(rows[3]!.getAttribute("data-slot")).toBe("local-model-row");
    expect(screen.getByRole("heading").textContent).toBe("Hook up your AI");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(start).toHaveBeenCalledWith({});
  });

  it("counts a stored key or configured model as connected", async () => {
    await initI18n();
    const { context } = ctx(false);
    const { container } = render(
      <ModelsStep
        ctx={context}
        connected={new Set(["openrouter", "gemini"])}
        refresh={async () => {}}
        heading={createRef()}
      />
    );
    const rows = [...container.querySelectorAll(".onboarding-row")];
    expect(rows.map((row) => row.getAttribute("data-connected"))).toEqual([
      "false",
      "true",
      "true",
      null,
    ]);
    // Signed out: Abacus's Connect starts a sign-in attempt from this row.
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(context.props.signIn).toHaveBeenCalledWith("signin");
  });

  it("opens the Gemini key dialog directly and the picker from Paste a key", async () => {
    await initI18n();
    const { context } = ctx(true);
    render(
      <ModelsStep
        ctx={context}
        connected={new Set()}
        refresh={async () => {}}
        heading={createRef()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Add API key" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(
      /Go to Google Gemini.*and get your API key/
    );
    expect(dialog.textContent).toContain("Stored on this machine only.");
    expect(
      screen.getByRole("button", { name: /Open Google Gemini/ })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Paste a key" }));
    expect(
      await screen.findByRole("menuitem", { name: /DeepSeek/ })
    ).toBeTruthy();
  });

  it("advances from Connect later and Continue", async () => {
    await initI18n();
    const { context } = ctx(true);
    render(
      <ModelsStep
        ctx={context}
        connected={new Set()}
        refresh={async () => {}}
        heading={createRef()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect later" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(context.advance).toHaveBeenCalledTimes(2);
  });
});
