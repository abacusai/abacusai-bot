import type { UpdateStatus } from "@abacus-ai/contract/update";
import { render, screen, fireEvent } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";

import { initI18n, i18n } from "#renderer/lib/i18n";

import { UpdatePillButton } from "./updates";
const status: UpdateStatus = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  criticalUpdate: false,
  failedPhase: null,
  manualInstall: null,
};
it("R5-T27 public pill hides idle, critical and stalled; ready relaunches and failed download retries", async () => {
  await initI18n();
  const install = vi.fn(async () => undefined),
    check = vi.fn(async () => undefined);
  const props = { onInstall: install, onCheck: check };
  const view = render(
    <I18nextProvider i18n={i18n}>
      <UpdatePillButton {...props} status={status} />
    </I18nextProvider>
  );
  const update = (patch: Partial<UpdateStatus>) =>
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <UpdatePillButton {...props} status={{ ...status, ...patch }} />
      </I18nextProvider>
    );
  expect(screen.queryByRole("button")).toBeNull();
  update({ downloaded: true, criticalUpdate: true });
  expect(screen.queryByRole("button")).toBeNull();
  update({ downloaded: true, installStalled: true });
  expect(screen.queryByRole("button")).toBeNull();
  update({ downloaded: true });
  fireEvent.click(screen.getByRole("button"));
  expect(install).toHaveBeenCalledTimes(1);
  update({ error: "failure", failedPhase: "download" });
  fireEvent.click(screen.getByRole("button"));
  expect(check).toHaveBeenCalledTimes(1);
  update({ downloading: true });
  expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
});
it("a manual .deb install pill leads to the steps and is inert without them", async () => {
  await initI18n();
  const manual = vi.fn();
  const ready = {
    ...status,
    downloaded: true,
    manualInstall: {
      command: "sudo apt install /tmp/b.deb",
      packagePath: "/tmp/b.deb",
    },
  };
  const props = { onInstall: vi.fn(), onCheck: vi.fn() };
  const view = render(
    <I18nextProvider i18n={i18n}>
      <UpdatePillButton {...props} status={ready} onManualInstall={manual} />
    </I18nextProvider>
  );
  const pill = screen.getByRole("button", { name: "Install update" });
  fireEvent.click(pill);
  expect(manual).toHaveBeenCalledTimes(1);
  expect(props.onInstall).not.toHaveBeenCalled();
  // A rejected click does not turn it into Try again.
  view.rerender(
    <I18nextProvider i18n={i18n}>
      <UpdatePillButton
        {...props}
        status={ready}
        installError="refused"
        onManualInstall={manual}
      />
    </I18nextProvider>
  );
  expect(screen.getByRole("button", { name: "Install update" })).not.toBeNull();
  view.rerender(
    <I18nextProvider i18n={i18n}>
      <UpdatePillButton {...props} status={ready} />
    </I18nextProvider>
  );
  expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
});
it("a ready update says how many terminals close, and lists every one behind a button the keyboard reaches", async () => {
  await initI18n();
  const { UpdateNotice } = await import("./update-notice");
  const { openTab } = await import("../sessions/dock/panel-tabs-store");
  // Four chats, one terminal each, all named "Terminal" in their own chat.
  const chats = [
    ["b", "Write release notes", null],
    ["a", "Fix the login page", "sleep"],
    ["c", "Plan the launch", null],
    ["d", "Tidy the README", null],
  ] as const;
  const openTerminals = chats.map(([id, chat, program]) => {
    const conversationKey = `["conversation",1,"w","session","${id}"]`;
    openTab(conversationKey, { ref: `terminal:t-${id}`, title: "Terminal" });
    return { conversationKey, terminalId: `t-${id}`, program, chat };
  });
  const install = vi.fn(async () => undefined);
  const view = render(
    <I18nextProvider i18n={i18n}>
      <UpdateNotice
        placement="composer"
        update={
          {
            status: {
              ...status,
              downloaded: true,
              updateInfo: { version: "9.9.9" },
              openTerminals,
            } as UpdateStatus,
            phase: "downloaded",
            clicked: false,
            installError: null,
            install,
            check: vi.fn(),
          } as never
        }
      />
    </I18nextProvider>
  );
  // Four shells, four counted; which ones is a button away, with no
  // tooltip on text a keyboard can't reach.
  expect(screen.getByText(/Restarting closes 4 terminals\./)).toBeTruthy();
  expect(view.container.querySelector("[title]:not(button):not(a)")).toBeNull();
  const which = screen.getByRole("button", { name: "See which" });
  which.focus();
  expect(document.activeElement).toBe(which);
  fireEvent.click(which);
  const list = await screen.findByRole("list");
  expect(
    [...list.querySelectorAll("li")].map((item) => item.textContent)
  ).toEqual([
    "Terminal (sleep) in Fix the login page",
    "Terminal in Write release notes",
    "Terminal in Plan the launch",
    "Terminal in Tidy the README",
  ]);
  expect(
    screen.getByRole("dialog", { name: "Terminals a restart closes" })
  ).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  fireEvent.click(screen.getByRole("button", { name: "Relaunch to update" }));
  expect(install).toHaveBeenCalledOnce();
  view.unmount();
});
