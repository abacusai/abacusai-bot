import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { draftStore } from "#renderer/features/chat/composer/draft-store";
import { openFloating, shellStore } from "#renderer/features/shell/shell-store";
import { renderApp } from "#renderer/test-support/app-harness";

import { sessionDraftsStore } from "./session-drafts";
import { newStartDraft, startDraftStore } from "./start-session";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  sessionDraftsStore.setState(() => ({ activeId: null, drafts: {} }));
  draftStore.setState(() => ({}));
  startDraftStore.setState(newStartDraft);
});

it("keeps, orders, deep-links and discards drafts with keyboard-accessible undo", async () => {
  sessionDraftsStore.setState(() => ({ activeId: null, drafts: {} }));
  startDraftStore.setState(newStartDraft);
  app = await renderApp("/sessions/new");
  const sidebar = within(
    await screen.findByRole("navigation", { name: "Sessions" })
  );
  expect(sidebar.queryByRole("button", { name: /Drafts/ })).toBeNull();
  const input = await screen.findByRole("textbox", {
    name: "Tell the agent what to do…",
  });
  const first = startDraftStore.state.id;
  fireEvent.change(input, { target: { value: "First draft\nMore detail" } });
  await sidebar.findByRole("link", { name: /First draft/ });
  fireEvent.click(sidebar.getByRole("button", { name: "New session" }));
  await waitFor(() => expect(startDraftStore.state.id).not.toBe(first));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Tell the agent what to do…",
        }) as HTMLTextAreaElement
      ).value
    ).toBe("")
  );
  const second = startDraftStore.state.id;
  fireEvent.change(
    screen.getByRole("textbox", { name: "Tell the agent what to do…" }),
    { target: { value: "Second draft" } }
  );
  await sidebar.findByRole("link", { name: /Second draft/ });
  expect(
    sidebar
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.includes("draft="))[0]
      ?.textContent
  ).toContain("Second draft");
  await act(async () => {
    openFloating("peek");
    await app!.router.navigate({
      to: "/sessions/new",
      search: { draft: first },
    } as never);
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Tell the agent what to do…",
        }) as HTMLTextAreaElement
      ).value
    ).toBe("First draft\nMore detail")
  );
  expect(shellStore.state.floating.open).toBe(false);
  expect(
    sidebar
      .getByRole("link", { name: /First draft/ })
      .getAttribute("aria-current")
  ).toBe("page");
  await act(async () => {
    await app!.router.navigate({ to: "/settings/general" } as never);
  });
  expect(sessionDraftsStore.state.drafts[first]?.composer.text).toBe(
    "First draft\nMore detail"
  );
  await act(async () => {
    await app!.router.navigate({
      to: "/sessions/new",
      search: { draft: first },
    } as never);
  });
  await screen.findByRole("textbox", { name: "Tell the agent what to do…" });
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Sessions" })).getByRole(
      "button",
      { name: "Discard draft: First draft" }
    )
  );
  await waitFor(() =>
    expect(sessionDraftsStore.state.drafts[first]).toBeUndefined()
  );
  expect(sessionDraftsStore.state.drafts[second]?.composer.text).toBe(
    "Second draft"
  );
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(startDraftStore.state.id).toBe(first));
  expect(draftStore.state[`draft:${first}`]?.text).toBe(
    "First draft\nMore detail"
  );
});
