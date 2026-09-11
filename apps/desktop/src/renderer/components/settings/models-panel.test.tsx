/**
 * The connect page, from the outside.
 *
 * What matters to a new user: every provider the app supports gets a card, a
 * pasted key is saved under the right provider, and the search box narrows
 * twenty cards down to the one they came for. Rendered against the real
 * PROVIDER_KEY_FIELDS so a provider added to the registry is covered here
 * without this file changing.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentProps, JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panel renders translated strings; the keys are what the assertions read.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));

import { PROVIDER_KEY_FIELDS } from "#shared/settings";

const saveApiKey = vi.fn(async () => ({}));
const listModels = vi.fn(async (): Promise<unknown[]> => []);
const listStoredKeyProviders = vi.fn(async (): Promise<string[]> => []);
const getSettings = vi.fn(async () => ({ apiKeys: {} }));
const removeMcpServer = vi.fn(async () => ({ ok: true }));
const startOpenRouterAuth = vi.fn(async () => ({ ok: true }) as unknown);
const cancelOpenRouterAuth = vi.fn(async () => undefined);
const cancelAbacusAuth = vi.fn(async () => undefined);
let queryClient: QueryClient;

const { ModelsSettingsPanel } = await import("./models-panel");

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  saveApiKey.mockClear();
  listModels.mockClear();
  getSettings.mockClear();
  listStoredKeyProviders.mockClear();
  removeMcpServer.mockClear();
  startOpenRouterAuth.mockClear();
  cancelOpenRouterAuth.mockClear();
  cancelAbacusAuth.mockClear();
  startOpenRouterAuth.mockResolvedValue({ ok: true });
  listStoredKeyProviders.mockResolvedValue([]);
  listModels.mockResolvedValue([]);

  (globalThis.window as unknown as { api: unknown }).api = {
    openExternal: vi.fn(),
    agent: {
      listModels,
      getSettings,
      listStoredKeyProviders,
      removeMcpServer,
      saveApiKey,
      startOpenRouterAuth,
      cancelOpenRouterAuth,
      cancelAbacusAuth,
      onEvent: () => () => undefined,
    },
  };
});

const openPage = async (provider?: string): Promise<void> => {
  render(
    <QueryClientProvider client={queryClient}>
      {(<ModelsSettingsPanel provider={provider} />) as JSX.Element}
    </QueryClientProvider>
  );
  await waitFor(() => byId("models-settings-page"));
  if (provider != null) {
    await waitFor(() => {
      const dialog = document.querySelector('[data-slot="dialog-content"]');
      if (dialog == null) throw new Error("provider dialog has not opened");
      return dialog;
    });
  }
};

describe("the provider grid", () => {
  it("shows a card for every provider in the registry", async () => {
    await openPage();

    for (const field of PROVIDER_KEY_FIELDS) {
      const card = document.querySelector(
        `[data-id="api-key-card-${field.provider}"]`
      );
      expect(card, `no card for "${field.provider}"`).toBeTruthy();
      expect(
        card?.querySelector("img, svg"),
        `no provider mark for "${field.provider}"`
      ).toBeTruthy();
    }
  });

  it("keeps provider controls on their focused detail pages", async () => {
    await openPage();

    for (const field of PROVIDER_KEY_FIELDS) {
      expect(
        document.querySelector(`[data-id="api-key-input-${field.provider}"]`)
      ).toBeNull();
    }
  });
});

describe("saving a key", () => {
  it("stores what was pasted under the provider whose card it is", async () => {
    await openPage("groq");

    fireEvent.change(byId("api-key-input-groq"), {
      target: { value: "gsk-test-key" },
    });
    fireEvent.keyDown(byId("api-key-input-groq"), { key: "Enter" });

    await waitFor(() =>
      expect(saveApiKey).toHaveBeenCalledWith("groq", "gsk-test-key")
    );
  });

  it("saves nothing when nothing was typed", async () => {
    await openPage("mistral");

    fireEvent.keyDown(byId("api-key-input-mistral"), { key: "Enter" });

    // saveAll resolves before any writes happen; a zero-draft save is a no-op.
    await waitFor(() => expect(saveApiKey).not.toHaveBeenCalled());
  });
});

describe("the search box", () => {
  it("narrows the grid to what matches", async () => {
    await openPage();

    fireEvent.change(byId("api-keys-filter"), { target: { value: "groq" } });

    expect(
      document.querySelector('[data-id="api-key-card-groq"]')
    ).toBeTruthy();
    expect(
      document.querySelector('[data-id="api-key-card-mistral"]')
    ).toBeNull();
  });

  it("matches the env var someone saw in a README", async () => {
    await openPage();

    fireEvent.change(byId("api-keys-filter"), {
      target: { value: "HF_TOKEN" },
    });

    expect(
      document.querySelector('[data-id="api-key-card-huggingface"]')
    ).toBeTruthy();
  });
});

describe("a key that is already stored", () => {
  it("offers a way to remove it, which the card had no room for before", async () => {
    listStoredKeyProviders.mockResolvedValue(["groq"]);
    await openPage("groq");

    fireEvent.click(byId("api-key-remove-groq"));
    await waitFor(() => byId("api-key-remove-dialog"));
    // The dialog's own confirm button, not the card's.
    fireEvent.click(
      byId("api-key-remove-dialog").querySelectorAll("button")[1]!
    );

    // An empty key is how the store deletes the entry.
    await waitFor(() => expect(saveApiKey).toHaveBeenCalledWith("groq", ""));
  });

  it("clears the key and leaves the gateway to the main process", async () => {
    // The gateway entry authenticates with that key, so left behind it answers
    // 401 forever. Removing it is no longer this panel's errand: main takes it
    // down whenever the key goes, by whatever route (handler.test.ts), which is
    // what stopped a key ending some other way from stranding the entry.
    listStoredKeyProviders.mockResolvedValue(["abacus"]);
    await openPage("abacus");

    fireEvent.click(byId("api-key-remove-abacus"));
    await waitFor(() => byId("api-key-remove-dialog"));
    fireEvent.click(
      byId("api-key-remove-dialog").querySelectorAll("button")[1]!
    );

    await waitFor(() => expect(saveApiKey).toHaveBeenCalledWith("abacus", ""));
    expect(removeMcpServer).not.toHaveBeenCalled();
  });

  it("leaves other providers' MCP servers alone when their key is removed", async () => {
    listStoredKeyProviders.mockResolvedValue(["groq"]);
    await openPage("groq");

    fireEvent.click(byId("api-key-remove-groq"));
    await waitFor(() => byId("api-key-remove-dialog"));
    fireEvent.click(
      byId("api-key-remove-dialog").querySelectorAll("button")[1]!
    );

    await waitFor(() => expect(saveApiKey).toHaveBeenCalledWith("groq", ""));
    expect(removeMcpServer).not.toHaveBeenCalled();
  });

  it("offers no Remove for a key this app cannot take back", async () => {
    // Configured through the catalog but absent from config.json: the shell
    // exported it, and nothing here can unexport it.
    listModels.mockResolvedValue([{ provider: "groq", configured: true }]);
    listStoredKeyProviders.mockResolvedValue([]);
    await openPage("groq");

    expect(byId("api-key-state-groq")).toBeTruthy();
    expect(
      document.querySelector('[data-id="api-key-remove-groq"]')
    ).toBeNull();
  });

  it("says a pasted key is unverified rather than claiming it is configured", async () => {
    listStoredKeyProviders.mockResolvedValue(["groq"]);
    await openPage("groq");

    expect(byId("api-key-state-groq").textContent).toContain(
      "apiKeys.notVerified"
    );
  });

  it("says Configured only where a browser sign-in actually used the key", async () => {
    listModels.mockResolvedValue([{ provider: "abacus", configured: true }]);
    await openPage("abacus");

    expect(byId("api-key-state-abacus").textContent).toContain(
      "apiKeys.configured"
    );
  });
});

describe("what crosses into the renderer", () => {
  it("resolves which providers are configured without reading any key", async () => {
    // The panel used to fetch the whole settings file — every stored secret —
    // to render a checkmark.
    await openPage();

    expect(getSettings).not.toHaveBeenCalled();
    expect(listStoredKeyProviders).toHaveBeenCalled();
  });
});

describe("a paste that could not be a key", () => {
  it("is refused in place instead of stored", async () => {
    await openPage("groq");

    fireEvent.change(byId("api-key-input-groq"), {
      target: { value: "export GROQ_API_KEY=gsk-test-key" },
    });
    fireEvent.keyDown(byId("api-key-input-groq"), { key: "Enter" });

    await waitFor(() => byId("api-key-invalid-groq"));
    expect(saveApiKey).not.toHaveBeenCalled();
  });

  it("stops complaining as soon as the field is edited again", async () => {
    await openPage("groq");

    fireEvent.change(byId("api-key-input-groq"), {
      target: { value: "https://console.groq.com/keys" },
    });
    fireEvent.keyDown(byId("api-key-input-groq"), { key: "Enter" });
    await waitFor(() => byId("api-key-invalid-groq"));

    fireEvent.change(byId("api-key-input-groq"), {
      target: { value: "gsk-a-real-looking-key" },
    });

    expect(
      document.querySelector('[data-id="api-key-invalid-groq"]')
    ).toBeNull();
  });
});

describe("an OpenRouter hop the user walks away from", () => {
  // The hop ends in a browser we do not control and the listener waits twenty
  // minutes. This page used to disable the button for all of it, with no
  // cancel — so someone whose signup never reached OpenRouter's authorize page
  // had nothing to press at the one moment they needed it.
  const hangingHop = (): void => {
    startOpenRouterAuth.mockReturnValue(new Promise(() => undefined) as never);
  };

  it("keeps Connect pressable, and a second press restarts the hop", async () => {
    hangingHop();
    await openPage("openrouter");

    fireEvent.click(byId("api-key-connect-openrouter"));
    await waitFor(() => expect(startOpenRouterAuth).toHaveBeenCalledTimes(1));

    // The label does not change — it still says Connect, and it is still
    // clickable. The spinner and the cancel carry the in-flight state.
    const button = byId("api-key-connect-openrouter");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.textContent).toContain("apiKeys.connectOpenRouter");

    fireEvent.click(button);

    await waitFor(() => expect(startOpenRouterAuth).toHaveBeenCalledTimes(2));
  });

  it("offers a cancel, and only while the hop is out", async () => {
    hangingHop();
    await openPage("openrouter");

    expect(
      document.querySelector('[data-id="api-key-connect-cancel-openrouter"]')
    ).toBeNull();

    fireEvent.click(byId("api-key-connect-openrouter"));
    await waitFor(() => byId("api-key-connect-cancel-openrouter"));

    fireEvent.click(byId("api-key-connect-cancel-openrouter"));

    await waitFor(() =>
      expect(
        document.querySelector('[data-id="api-key-connect-cancel-openrouter"]')
      ).toBeNull()
    );
    expect(cancelOpenRouterAuth).toHaveBeenCalled();
  });

  it("abandons the hop when the page is closed, not holding the port", async () => {
    hangingHop();
    const view = render(
      <QueryClientProvider client={queryClient}>
        {(<ModelsSettingsPanel provider="openrouter" />) as JSX.Element}
      </QueryClientProvider>
    );
    await waitFor(() => byId("api-key-connect-openrouter"));
    fireEvent.click(byId("api-key-connect-openrouter"));

    view.unmount();

    expect(cancelOpenRouterAuth).toHaveBeenCalled();
  });
});
