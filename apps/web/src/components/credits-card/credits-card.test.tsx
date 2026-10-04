import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderWithDb } from "../../features/chat/testing";
import { CreditsCard, missingFreeSources } from "./index";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

it("offers the next two missing sources in the pool's spending order", () => {
  expect(missingFreeSources({})).toEqual(["gemini", "openrouter"]);
  expect(missingFreeSources({ gemini: true, openrouter: true })).toEqual([
    "mistral",
    "nvidia",
  ]);
  expect(
    missingFreeSources({
      gemini: true,
      openrouter: true,
      mistral: true,
      nvidia: true,
    })
  ).toEqual(["cerebras", "groq"]);
});

it("connects OpenRouter and replays a dead turn once after the refreshed catalog", async () => {
  const onResume = vi.fn(async () => {});
  const configured = { gemini: true };
  const connectFreeSource = vi.fn(async () => {
    Object.assign(configured, { openrouter: true });
    return true;
  });
  const rendered = await renderWithDb(
    <CreditsCard
      tier="free"
      host={{
        openExternal: async () => {},
        configuredFreeSources: async () => configured,
        connectFreeSource,
      }}
      onResume={onResume}
    />
  );
  cleanup = rendered.cleanup;
  await waitFor(() =>
    expect(document.querySelector('[data-source="openrouter"]')).toBeTruthy()
  );
  fireEvent.click(
    document.querySelector<HTMLButtonElement>(
      '[data-source="openrouter"] button'
    )!
  );
  await waitFor(() => expect(onResume).toHaveBeenCalledOnce());
  expect(connectFreeSource).toHaveBeenCalledExactlyOnceWith(
    "openrouter",
    undefined
  );
});

it("shows top-up only on paid tiers and never sells a plan to the free tier", async () => {
  const openExternal = vi.fn(async () => {});
  const rendered = await renderWithDb(
    <CreditsCard tier="basic" host={{ openExternal }} />
  );
  cleanup = rendered.cleanup;
  expect(document.querySelector("[data-source]")).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  expect(openExternal).toHaveBeenCalledWith("https://agent.abacus.ai/");
});
