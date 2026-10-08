import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

describe("the checkout capability", () => {
  it.skipIf(process.platform === "win32")(
    "is read from the descriptor the desktop wrote, which is then closed",
    async () => {
      vi.resetModules();
      const { receiveCheckoutToken, withCheckoutToken } =
        await import("./checkout-run.js");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-fd-"));
      const fifo = path.join(dir, "pipe");
      execFileSync("mkfifo", [fifo]);
      const fd = fs.openSync(
        fifo,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
      );
      const writer = fs.openSync(fifo, fs.constants.O_WRONLY);
      fs.writeSync(writer, "cap-1\n");
      fs.closeSync(writer);

      receiveCheckoutToken(fd);
      fs.rmSync(dir, { recursive: true, force: true });

      // Closed once read.
      expect(() => fs.fstatSync(fd)).toThrow();

      const call = vi.fn(async () => ({ text: "", isError: false }));
      await withCheckoutToken(call)!({ action: "start" });
      expect(call).toHaveBeenCalledWith({ action: "start", token: "cap-1" });
    }
  );

  it("ignores a descriptor that is not a pipe or a socket", async () => {
    vi.resetModules();
    const { receiveCheckoutToken, withCheckoutToken } =
      await import("./checkout-run.js");
    const io = {
      fstatSync: () => ({ isFIFO: () => false, isSocket: () => false }),
      readSync: vi.fn(),
      closeSync: vi.fn(),
    } as unknown as typeof fs;
    receiveCheckoutToken(9, io);
    if (process.platform !== "win32")
      expect(io.readSync).not.toHaveBeenCalled();
    expect(io.closeSync).toHaveBeenCalledWith(9);
    if (process.platform !== "win32")
      expect(withCheckoutToken(async () => null)).toBeNull();
  });

  it("gives no handle without one, whatever the environment says", async () => {
    vi.resetModules();
    process.env.ABACUSAI_BOT_CHECKOUT_TOKEN = "from-env";
    const { withCheckoutToken } = await import("./checkout-run.js");
    expect(withCheckoutToken(async () => null)).toBeNull();
    delete process.env.ABACUSAI_BOT_CHECKOUT_TOKEN;
  });
});
