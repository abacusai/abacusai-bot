/** Electron-only R6-T41 entry: the shipped permission component, fonts and styles. */
import { Store } from "@tanstack/react-store";
import { createRoot } from "react-dom/client";

import { descriptor } from "#renderer/features/chat/fixtures/builders";
import { NotchPermissionList } from "#renderer/features/chat/kit/permissions/notch-list";
import type { ChatRuntime } from "#renderer/features/chat/runtime/runtime";
import { emptyThreadState } from "#renderer/features/chat/store/thread-store";
import { initI18n, changeLanguage, i18n } from "#renderer/lib/i18n";
import type { SupportedLanguage } from "#renderer/lib/i18n/languages";
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
  await new Promise((resolve) => setTimeout(resolve, 450));
  const buttons = [...node.querySelectorAll("button")]
    .filter((button) => getComputedStyle(button).visibility !== "hidden")
    .map((button) => button.textContent?.trim() ?? "");
  const body = node.querySelector<HTMLElement>(".notch-body")!;
  return {
    accept: buttons.includes(i18n.t("chat.permission.action.allow")),
    buttons,
    visibleOverflow:
      body.scrollHeight > 187 || body.scrollWidth > body.clientWidth,
    font: getComputedStyle(body).fontFamily,
  };
};

/** Mounted listening controls, measured by Chromium with the shipped shape. */
import { ListeningControls } from "#renderer/features/notch/listening";
import { shapeFor } from "#renderer/features/notch/shape";
import type { NotchLayout } from "#shared/contract/notch";
declare global {
  interface Window {
    __phase6ListeningFit(
      mode: NotchLayout["mode"],
      language: SupportedLanguage
    ): Promise<{ controls: number; visible: boolean; height: number }>;
  }
}
window.__phase6ListeningFit = async (mode, language) => {
  await initI18n();
  await changeLanguage(language);
  await document.fonts.ready;
  const layout: NotchLayout = {
    displayId: 1,
    mode,
    growth: mode === "capsule" ? "up" : "down",
    notch: mode === "notch" ? { width: 200, height: 32 } : null,
    maxShape: { width: 560, height: 220 },
  };
  const shape = shapeFor(
    { route: "/call", quietUntil: null, expanded: true } as never,
    layout
  );
  root.render(
    <div
      className="notch-shape"
      data-mode={mode}
      data-reduced="true"
      style={shape}
    >
      <div
        className="notch-wings"
        style={{ height: mode === "capsule" ? 36 : 32 }}
      />
      <div className="notch-body">
        <ListeningControls
          state="recording"
          level={0.5}
          end={() => {}}
          cancel={() => {}}
        />
      </div>
    </div>
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const bounds = node
    .querySelector<HTMLElement>(".notch-shape")!
    .getBoundingClientRect();
  const controls = [...node.querySelectorAll("button")];
  return {
    controls: controls.length,
    height: bounds.height,
    visible: controls.every((control) => {
      const rect = control.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= bounds.left &&
        rect.right <= bounds.right &&
        rect.top >= bounds.top &&
        rect.bottom <= bounds.bottom &&
        getComputedStyle(control).visibility === "visible"
      );
    }),
  };
};

import { NotchHeader, NotchSurface } from "#renderer/features/notch/frame";
import { IdleView } from "#renderer/features/notch/idle";
import { NotchContext, type NotchViewContext } from "#renderer/notch-context";
import { Button } from "#renderer/ui/button";

declare global {
  interface Window {
    __notchGeometryFit(): Promise<unknown[]>;
  }
}
window.__notchGeometryFit = async () => {
  await initI18n();
  await changeLanguage("en-US");
  await document.fonts.ready;
  const rows = [];
  for (const height of [24, 33, 40]) {
    const layout: NotchLayout = {
      displayId: 1,
      mode: "notch",
      growth: "down",
      notch: { x: 763, width: 185, height },
      maxShape: { width: 560, height: 220 },
    };
    for (const route of [
      "/idle",
      "/working",
      "/call",
      "/reply/$id",
      "/approval/$id",
    ]) {
      for (const expanded of [false, true]) {
        const shape = shapeFor({ route, expanded } as never, layout);
        root.render(
          <NotchContext
            value={
              {
                db: {
                  collections: {
                    bots: {
                      toArray: [
                        { id: "audit", name: "Notch audit", channel: null },
                      ],
                    },
                    routines: { toArray: [] },
                  },
                },
              } as unknown as NotchViewContext
            }
          >
            <NotchSurface
              layout={layout}
              shape={shape}
              expanded={expanded}
              reduced
            >
              <NotchHeader
                reduced
                layout={layout}
                left={
                  <div className="notch-wing">
                    <i style={{ width: 20, flexShrink: 0 }} />
                    <span className="notch-label truncate">
                      {route === "/approval/$id" && expanded
                        ? "Notch audit"
                        : i18n.t(
                            route === "/call"
                              ? "notch.listening.title"
                              : route === "/reply/$id"
                                ? "notch.wings.reply"
                                : route === "/approval/$id"
                                  ? "notch.wings.approval"
                                  : route === "/working"
                                    ? "notch.wings.working"
                                    : "notch.wings.idle"
                          )}
                    </span>
                  </div>
                }
                right={
                  <div className="notch-wing">
                    {expanded && (
                      <Button>{i18n.t("notch.actions.open")}</Button>
                    )}
                  </div>
                }
              />
              {expanded && (
                <div className="notch-body">
                  <IdleView />
                </div>
              )}
            </NotchSurface>
          </NotchContext>
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        const surface = node.querySelector<HTMLElement>(".notch-shape")!;
        const bounds = surface.getBoundingClientRect();
        const label = node.querySelector<HTMLElement>(".notch-wing span")!;
        const wings = [
          ...node.querySelectorAll<HTMLElement>(".notch-wing"),
        ].map((wing) => wing.getBoundingClientRect());
        const cameraLeft = bounds.left + (bounds.width - 185) / 2;
        const buttons = [...node.querySelectorAll(".notch-body button")].map(
          (button) => button.getBoundingClientRect()
        );
        const inside = (x: number, y: number) =>
          surface.contains(
            document.elementFromPoint(bounds.left + x, bounds.top + y)
          );
        rows.push({
          height,
          route,
          expanded,
          actualHeight: bounds.height,
          headerFits: label.scrollWidth <= label.clientWidth,
          cameraClear:
            wings[0]!.right <= cameraLeft &&
            wings[1]!.left >= cameraLeft + 185 &&
            buttons.every((r) => r.top >= bounds.top + height),
          bodyFits: buttons.every(
            (r) =>
              r.left >= bounds.left + 20 &&
              r.right <= bounds.right - 20 &&
              r.bottom <= bounds.bottom - 12
          ),
          actionsCentered:
            !buttons.length ||
            Math.abs(
              (buttons[0]!.left + buttons.at(-1)!.right) / 2 -
                (bounds.left + bounds.right) / 2
            ) < 1,
          shoulder: inside(8, 0.1) && !inside(8, 8),
          bottomCurve:
            !inside(13, bounds.height - 1) &&
            inside(bounds.width / 2, bounds.height - 0.5),
          belowClear: !inside(bounds.width / 2, bounds.height + 0.5),
        });
      }
    }
  }
  return rows;
};
