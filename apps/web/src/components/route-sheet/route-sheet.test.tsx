import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { renderWithDb } from "#renderer/features/chat/testing";

import { RouteSheet } from "./index";

const router = vi.hoisted(() => ({
  back: vi.fn(),
  navigate: vi.fn(),
  canGoBack: true,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useCanGoBack: () => router.canGoBack,
  useRouter: () => ({
    history: { back: router.back },
    navigate: router.navigate,
  }),
}));

it.each([true, false])(
  "closes the still-used route sheet with history=%s",
  async (canGoBack) => {
    router.canGoBack = canGoBack;
    router.back.mockClear();
    router.navigate.mockClear();
    const current = await renderWithDb(
      <RouteSheet title="Routine" fallbackHref="/routines">
        <p>Content</p>
      </RouteSheet>
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    if (canGoBack) {
      expect(router.back).toHaveBeenCalledOnce();
      expect(router.navigate).not.toHaveBeenCalled();
    } else {
      expect(router.navigate).toHaveBeenCalledWith({
        href: "/routines",
        replace: true,
      });
      expect(router.back).not.toHaveBeenCalled();
    }
    await current.cleanup();
  }
);
