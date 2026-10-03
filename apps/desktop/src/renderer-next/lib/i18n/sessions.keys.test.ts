import { expect, it } from "vitest";

import enUS from "#locales/en-US.json";
const oldSources = import.meta.glob<string>(
  "../../../renderer/components/chat/session-starters.ts",
  { eager: true, query: "?raw", import: "default" }
);
const old = Object.values(oldSources)[0];
import { SESSION_STARTERS } from "#next/features/sessions/starters";

import current from "../../features/sessions/starters.ts?raw";
const sources = import.meta.glob<string>(
  [
    "../../features/sessions/**/*.{ts,tsx}",
    "../../routes/_shell/(sessions)/*.{ts,tsx}",
  ],
  { eager: true, query: "?raw", import: "default" }
);
it("R4-T22 literal session translation keys resolve", () => {
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/t\(\s*["'](sessions\.[\w.-]+)["']/g)) {
      const value = match[1]!
        .split(".")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown>)?.[key],
          enUS
        );
      expect(typeof value, `${file}: ${match[1]}`).toBe("string");
    }
  }
});
it("R4-T22 starter prompts remain byte-identical to the existing prompts", () => {
  expect(current).toBe(old);
  expect(SESSION_STARTERS).toHaveLength(6);
  for (const starter of SESSION_STARTERS)
    expect(enUS.sessions.start.starters).toHaveProperty(starter.id);
});
