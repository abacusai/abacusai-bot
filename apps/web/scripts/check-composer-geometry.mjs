import { pathToFileURL } from "node:url";

export function inspectComposerGeometry() {
  const naming = document.querySelector(
    '[data-testid="bot-start"] [data-slot="input-group"]'
  );
  const surface =
    naming ?? document.querySelector('[data-slot="composer-surface"]');
  if (!surface)
    throw Error("Open the bot naming page or a chat composer first");
  const button = [...surface.querySelectorAll("button.concentric")].at(-1);
  if (!button) throw Error("No trailing composer button");
  const bounds = surface.getBoundingClientRect();
  const control = button.getBoundingClientRect();
  const radius = parseFloat(getComputedStyle(surface).borderBottomRightRadius);
  const buttonRadius = parseFloat(
    getComputedStyle(button).borderBottomRightRadius
  );
  const insets = {
    right: bounds.right - control.right,
    bottom: bounds.bottom - control.bottom,
  };
  const failures = [];
  const close = (a, b) => Math.abs(a - b) < 0.5;
  if (!close(insets.right, insets.bottom))
    failures.push("Unequal trailing button insets");
  if (!close(buttonRadius, radius - insets.right))
    failures.push("Button corners are not concentric");
  if (control.height < 32 || control.height > 36)
    failures.push("Button is outside 32–36px");
  if (naming && (bounds.height < 44 || bounds.height > 52))
    failures.push("Naming input is not compact");
  if (naming && !close(control.top - bounds.top, insets.right))
    failures.push("Naming button is not centered");
  if (document.documentElement.scrollWidth > innerWidth)
    failures.push("Horizontal page overflow");
  return { height: bounds.height, radius, buttonRadius, insets, failures };
}

async function main() {
  const port = process.env.ABACUSAI_BOT_DEBUG_PORT;
  if (!port) throw Error("Set ABACUSAI_BOT_DEBUG_PORT for your isolated app");
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  const target = targets.find(
    (page) => page.type === "page" && !page.url.includes("notch")
  );
  if (!target) throw Error("No renderer on the requested debug port");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const response = JSON.parse(data);
    const callback = pending.get(response.id);
    if (!callback) return;
    pending.delete(response.id);
    if (response.error) callback.reject(Error(response.error.message));
    else callback.resolve(response.result);
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const width = Number(process.argv[2]);
  try {
    if (width) {
      await request("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const result = await request("Runtime.evaluate", {
      expression: `(${inspectComposerGeometry.toString()})()`,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description);
    console.log(JSON.stringify(result.result.value));
    if (result.result.value.failures.length) process.exitCode = 1;
  } finally {
    if (width) await request("Emulation.clearDeviceMetricsOverride", {});
    socket.close();
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
