/** The one connect hop the picker rows and the out-of-credits cards share. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

const { missingFreeSources, useConnectFreeProvider } =
  await import("./use-connect-free-provider");

const startOpenRouterAuth = vi.fn(async () => ({ ok: true as const }));
const listModels = vi.fn(async () => []);
const openExternal = vi.fn();

const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => {
  navigate.mockClear();
  startOpenRouterAuth.mockClear();
  listModels.mockClear();
  openExternal.mockClear();
  Object.assign(window, {
    api: { agent: { startOpenRouterAuth, listModels }, openExternal },
  });
});

describe("missingFreeSources", () => {
  it("lists the free sources not yet connected, OpenRouter first", () => {
    expect(missingFreeSources(undefined)).toEqual(["openrouter", "gemini"]);
    expect(missingFreeSources({ openrouter: true })).toEqual(["gemini"]);
    expect(missingFreeSources({ openrouter: true, gemini: true })).toEqual([]);
  });
});

describe("useConnectFreeProvider", () => {
  it("connects OpenRouter and re-reads the catalog", async () => {
    const { result } = renderHook(() => useConnectFreeProvider(), { wrapper });

    let connected = false;
    await act(async () => {
      connected = await result.current.connect("openrouter");
    });

    expect(connected).toBe(true);
    expect(listModels).toHaveBeenCalledWith(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.connecting).toBeNull();
  });

  it("falls back to the keys panel when the sign-in fails, not when it is cancelled", async () => {
    const { result } = renderHook(() => useConnectFreeProvider(), { wrapper });

    startOpenRouterAuth.mockResolvedValueOnce({
      ok: false,
      error: "closed",
      cancelled: true,
    } as never);
    await act(async () => {
      expect(await result.current.connect("openrouter")).toBe(false);
    });
    expect(navigate).not.toHaveBeenCalled();

    startOpenRouterAuth.mockResolvedValueOnce({
      ok: false,
      error: "boom",
    } as never);
    await act(async () => {
      expect(await result.current.connect("openrouter")).toBe(false);
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/models",
      search: { provider: "openrouter" },
    });
    expect(listModels).not.toHaveBeenCalled();
  });

  // Google has no sign-in hop: the key is pasted. It used to open the browser
  // and send the user to Settings, leaving whatever they were doing; the key
  // dialog opens where they already are, and carries the link itself.
  it("asks for Google's key in the dialog, going nowhere", async () => {
    const { result } = renderHook(() => useConnectFreeProvider(), { wrapper });

    await act(async () => {
      expect(await result.current.connect("gemini")).toBe(false);
    });

    expect(openExternal).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    // The caller renders it; open only once the paste has been asked for.
    render(<>{result.current.keyDialog}</>, { wrapper });
    expect(
      document.querySelector('[data-id="provider-key-dialog"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-id="provider-key-input"]')
    ).not.toBeNull();
  });

  it("keeps the dialog shut until a key is actually wanted", () => {
    const { result } = renderHook(() => useConnectFreeProvider(), { wrapper });

    render(<>{result.current.keyDialog}</>, { wrapper });

    expect(
      document.querySelector('[data-id="provider-key-dialog"]')
    ).toBeNull();
  });
});
