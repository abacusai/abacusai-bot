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
