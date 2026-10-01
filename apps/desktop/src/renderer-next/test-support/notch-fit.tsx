/** Electron-only R6-T41 entry: the shipped permission component, fonts and styles. */
import { Store } from "@tanstack/react-store";
import { createRoot } from "react-dom/client";

import { descriptor } from "#next/features/chat/fixtures/builders";
import { NotchPermissionList } from "#next/features/chat/kit/permissions/notch-list";
import type { ChatRuntime } from "#next/features/chat/runtime/runtime";
import { emptyThreadState } from "#next/features/chat/store/thread-store";
import { initI18n, changeLanguage, i18n } from "#next/lib/i18n";
import type { SupportedLanguage } from "#next/lib/i18n/languages";
import type { PermissionRequest } from "#shared/agent-types";

const thread = new Store(emptyThreadState());
const host = new Store({ store: thread });
const runtime = {
  session: () => ({ hostStore: host }),
  respondPermission: async () => undefined,
} as unknown as ChatRuntime;
const node = document.createElement("div");
document.body.append(node);
const root = createRoot(node);
declare global {
  interface Window {
    __phase6Fit(
      request: PermissionRequest,
      width: number,
      language: SupportedLanguage
    ): Promise<{
      accept: boolean;
      buttons: string[];
      visibleOverflow: boolean;
      font: string;
    }>;
  }
}
window.__phase6Fit = async (request, width, language) => {
  await initI18n();
  await changeLanguage(language);
  await document.fonts.ready;
  thread.setState((state) => ({
    ...state,
    permissions: { ...state.permissions, items: [descriptor(request)] },
  }));
  root.render(
    <div className="notch-shape" style={{ width, height: 220 }}>
      <div className="notch-wings" style={{ height: 33 }} />
      <div className="notch-body">
        <NotchPermissionList runtime={runtime} threadId="t-1" maxHeight={169} />
      </div>
    </div>
  );
  // Chromium's layout effects must measure after the font and the new width commit.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const buttons = [...node.querySelectorAll("button")].map(
    (button) => button.textContent?.trim() ?? ""
  );
  const body = node.querySelector<HTMLElement>(".notch-body")!;
  return {
    accept: buttons.includes(i18n.t("chat.permission.action.allow")),
    buttons,
    visibleOverflow:
      body.scrollHeight > 187 || body.scrollWidth > body.clientWidth,
    font: getComputedStyle(body).fontFamily,
  };
};
