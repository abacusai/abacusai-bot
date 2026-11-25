/**
 * The inline title rename closes at once; a refused write leaves the old
 * title on screen and says why (spec 09 D7).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { i18n } from "#renderer/lib/i18n";

import { SessionIdentity } from "./sessions-pages";

// The page's words come from the app's copy: load it, without the React
// binding, so this test's keys still read as keys.
beforeAll(() =>
  i18n.init({ resources: { "en-US": { translation: enUS } }, lng: "en-US" })
);

const refused = Promise.reject(new Error("Name taken"));
refused.catch(() => undefined);
const update = vi.fn(() => ({ isPersisted: { promise: refused } }));

vi.mock("#renderer/data/db", () => ({
  useDb: () => ({ collections: { sessions: { update } } }),
}));
vi.mock("./data/queries", () => ({
  useSession: () => ({ id: "s1", label: "Old title", workspaceId: "w" }),
  useWorkspace: () => ({ label: "repo" }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("closes the editor before the write settles and keeps the old title on a refusal", async () => {
  render(<SessionIdentity sessionId="s1" />);
  fireEvent.click(
    screen.getByRole("button", { name: "sessions.sidebar.rename" })
  );
  const input = screen.getByRole("textbox", { name: "sessions.sidebar.name" });
  fireEvent.change(input, { target: { value: "New title" } });
  fireEvent.submit(input.closest("form")!);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(update).toHaveBeenCalledTimes(1);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Something went wrong. Try again."
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "sessions.sidebar.rename" })
        .textContent
    ).toBe("Old title")
  );
});
