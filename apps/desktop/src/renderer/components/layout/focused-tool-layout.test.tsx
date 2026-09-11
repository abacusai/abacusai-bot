import { fireEvent, render } from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div data-testid="focused-route-outlet">Route content</div>,
}));

const { FocusedToolLayout } = await import("./focused-tool-layout");
const { FocusedPage, FocusedPageBody, FocusedPageLead, FocusedPageToolbar } =
  await import("./focused-page");

const bySlot = (slot: string): HTMLElement | null =>
  document.querySelector(`[data-slot="${slot}"]`);

const renderLayout = ({
  children,
  fallback = vi.fn(),
  sidebar,
}: {
  children?: ReactNode;
  fallback?: () => void;
  sidebar?: ReactNode;
} = {}) => {
  const result = render(
    <FocusedToolLayout
      title="Connectors"
      onBack={fallback}
      sidebar={sidebar}
      sidebarLabel="Connector sections"
    >
      {children}
    </FocusedToolLayout>
  );
  return { ...result, fallback };
};

beforeEach(() => vi.clearAllMocks());

describe("FocusedToolLayout", () => {
  it("uses the route family's explicit root destination", () => {
    const { fallback, getByRole } = renderLayout();

    fireEvent.click(getByRole("button", { name: "Back" }));

    expect(fallback).toHaveBeenCalledOnce();
  });

  it("provides focused window chrome and an accessible page-owned sidebar", () => {
    const { getByRole } = renderLayout({
      children: <div>Connector list</div>,
      sidebar: <nav>Settings links</nav>,
    });

    const shell = bySlot("focused-tool-layout");
    const titlebar = bySlot("focused-titlebar");
    const content = bySlot("focused-page-content");

    expect(getByRole("heading", { level: 1 }).textContent).toBe("Connectors");
    expect(
      getByRole("complementary", { name: "Connector sections" })
    ).not.toBeNull();
    expect(shell?.contains(titlebar)).toBe(true);
    expect(shell?.contains(content)).toBe(true);
    expect(content?.classList.contains("overflow-hidden")).toBe(true);
    expect(
      bySlot("focused-page-sidebar")?.classList.contains("scrollbar-autohide")
    ).toBe(true);
    expect(document.querySelector("[data-sidebar='rail']")).toBeNull();
    expect(document.querySelector("[data-terminal-owner]")).toBeNull();
  });

  it("provides one title-free body recipe for focused pages", () => {
    const { getByText, queryByRole } = renderLayout({
      children: (
        <FocusedPage>
          <FocusedPageToolbar>Filters</FocusedPageToolbar>
          <FocusedPageBody>
            <FocusedPageLead description="Supporting copy" />
            <div>Page content</div>
          </FocusedPageBody>
        </FocusedPage>
      ),
    });

    expect(getByText("Filters")).not.toBeNull();
    expect(getByText("Supporting copy")).not.toBeNull();
    expect(getByText("Page content")).not.toBeNull();
    expect(queryByRole("heading", { level: 1 })?.textContent).toBe(
      "Connectors"
    );
    expect(bySlot("focused-page-scroll-area")).not.toBeNull();
  });

  it("renders the matched child outlet when no content slot is supplied", () => {
    const { getByTestId } = renderLayout();

    expect(getByTestId("focused-route-outlet").textContent).toBe(
      "Route content"
    );
  });
});
