import { describe, expect, it, vi } from "vitest";

describe("the checkout capability", () => {
  it("is read once, sent with every browser_checkout call, and gone from the environment", async () => {
    vi.resetModules();
    process.env.ABACUSAI_BOT_CHECKOUT_TOKEN = "cap-1";
    const { withCheckoutToken } = await import("./checkout-run.js");
    const call = vi.fn(async () => ({ text: "", isError: false }));
    const withToken = withCheckoutToken(call)!;
    expect(process.env.ABACUSAI_BOT_CHECKOUT_TOKEN).toBeUndefined();
    await withToken({ action: "start" });
    expect(call).toHaveBeenCalledWith({ action: "start", token: "cap-1" });
  });

  it("gives no handle without one", async () => {
    vi.resetModules();
    delete process.env.ABACUSAI_BOT_CHECKOUT_TOKEN;
    const { withCheckoutToken } = await import("./checkout-run.js");
    expect(withCheckoutToken(async () => null)).toBeNull();
  });
});
