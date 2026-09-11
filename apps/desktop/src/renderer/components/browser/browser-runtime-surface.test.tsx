import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserRuntimeState } from "#shared/contracts";

import {
  browserResourceStore,
  createBrowserResourceState,
  type BrowserResource,
} from "../../stores/browser-resource-store";
import { sessionConversationKey } from "../../stores/right-panel-store";
import { TooltipProvider } from "../ui/tooltip";
import { BrowserRuntimeSurface } from "./browser-runtime-surface";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const scope = sessionConversationKey("workspace-one", "session-one");
const resource: BrowserResource = {
  id: "browser-one" as BrowserResource["id"],
  scope,
  url: null,
  title: "Browser",
  profileId: null,
  navigation: {
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  },
};
const lease = {
  conversationKey: scope,
  resourceId: resource.id,
  generation: 1,
};
const state: BrowserRuntimeState = {
  lease,
  url: "about:blank",
  title: "Browser",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  focused: false,
  crashed: false,
  devToolsOpen: false,
  zoomFactor: 1,
};

describe("browser runtime surface", () => {
  let emitRuntimeEvent: ((event: unknown) => void) | undefined;
  const materializeBrowserRuntime = vi.fn(async () => state);
  const presentBrowserRuntime = vi.fn(async () => state);
  const navigateBrowserRuntime = vi.fn(async () => ({
    ...state,
    url: "http://localhost:5173/",
  }));
  const hideBrowserRuntime = vi.fn(async () => undefined);
  const captureBrowserRuntime = vi.fn(async () => ({
    dataUrl: "data:image/jpeg;base64,c2NyZWVuc2hvdA==",
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 640,
      bottom: 480,
      width: 640,
      height: 480,
      toJSON: () => ({}),
    });
    browserResourceStore.setState(() => createBrowserResourceState());
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        agent: {
          materializeBrowserRuntime,
          presentBrowserRuntime,
          navigateBrowserRuntime,
          hideBrowserRuntime,
          captureBrowserRuntime,
          listBrowserProfiles: vi.fn(async () => []),
          importBrowserProfile: vi.fn(async () => ({ success: true })),
          onEvent: vi.fn((listener: (event: unknown) => void) => {
            emitRuntimeEvent = listener;
            return vi.fn();
          }),
        },
        openExternal: vi.fn(),
      },
    });
  });

  it("does not overwrite an address draft when runtime state changes", async () => {
    render(
      <TooltipProvider>
        <BrowserRuntimeSurface scope={scope} resource={resource} />
      </TooltipProvider>
    );

    await waitFor(() => expect(emitRuntimeEvent).toBeTypeOf("function"));
    const address = screen.getByRole("textbox", {
      name: "workspace.preview.address",
    });
    fireEvent.change(address, { target: { value: "localhost:5173/docs" } });
    emitRuntimeEvent?.({
      type: "browser-runtime-state-updated",
      state: { ...state, loading: true },
    });

    expect((address as HTMLInputElement).value).toBe("localhost:5173/docs");

    fireEvent.keyDown(address, { key: "Escape" });
    expect((address as HTMLInputElement).value).toBe("");
  });

  it("materializes once, presents its measured host, and normalizes local URLs", async () => {
    const rendered = render(
      <TooltipProvider>
        <BrowserRuntimeSurface scope={scope} resource={resource} />
      </TooltipProvider>
    );

    await waitFor(() =>
      expect(materializeBrowserRuntime).toHaveBeenCalledOnce()
    );
    expect(materializeBrowserRuntime).toHaveBeenCalledWith({
      conversationKey: scope,
      resourceId: resource.id,
    });

    const address = screen.getByRole("textbox", {
      name: "workspace.preview.address",
    });
    fireEvent.change(address, { target: { value: "localhost:5173" } });
    fireEvent.submit(address.closest("form")!);

    await waitFor(() =>
      expect(navigateBrowserRuntime).toHaveBeenCalledWith({
        lease,
        navigation: { action: "url", url: "http://localhost:5173" },
      })
    );

    rendered.unmount();
    await waitFor(() =>
      expect(hideBrowserRuntime).toHaveBeenCalledWith({
        lease,
        presentationId: expect.any(String),
      })
    );
  });

  it("reuses a warm placeholder while an overlay occludes the native view", async () => {
    const { container } = render(
      <TooltipProvider>
        <BrowserRuntimeSurface scope={scope} resource={resource} />
      </TooltipProvider>
    );

    await waitFor(() => expect(captureBrowserRuntime).toHaveBeenCalledOnce());
    const placeholder = container.querySelector<HTMLImageElement>(
      "[data-placeholder-active]"
    );
    expect(placeholder?.dataset.placeholderActive).toBe("false");
    const source = placeholder?.src;

    fireEvent.click(
      screen.getByRole("button", { name: "workspace.preview.moreActions" })
    );

    await waitFor(() =>
      expect(placeholder?.dataset.placeholderActive).toBe("true")
    );
    expect(placeholder?.src).toBe(source);
    expect(captureBrowserRuntime).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(placeholder?.dataset.placeholderActive).toBe("false")
    );
    expect(placeholder?.src).toBe(source);
    expect(captureBrowserRuntime).toHaveBeenCalledOnce();
  });
});
