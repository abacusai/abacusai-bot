import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket from "ws";

export async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  socket.on("close", (code, reason) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`CDP disconnected (${code}: ${String(reason)})`));
    }
    pending.clear();
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 120_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        })
      );
    });
  return {
    send,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    close() {
      socket.close();
    },
  };
}

export async function launch({
  executable,
  home,
  port,
  log,
  args = [],
  env = {},
  initScript,
  directPage = false,
}) {
  if (
    !path.isAbsolute(home) ||
    !fs.existsSync(path.join(home, ".synthetic-cutover-home"))
  )
    throw new Error(
      "Refusing an unmarked home; use a fresh synthetic fixture directory"
    );
  const output = fs.openSync(log, "w");
  const spawnedAt = Date.now();
  const offlineArgs = [
    `--remote-debugging-port=${port}`,
    "--proxy-server=http://127.0.0.1:9",
    "--no-sandbox",
    ...args,
  ];
  const child = spawn(
    process.platform === "darwin" ? "/usr/bin/sandbox-exec" : executable,
    process.platform === "darwin"
      ? [
          "-p",
          '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
          executable,
          ...offlineArgs,
        ]
      : offlineArgs,
    {
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        ABACUSAI_BOT_HOME: home,
        ABACUSAI_BOT_BASE: home,
        ...env,
      },
      stdio: ["ignore", output, output],
      detached: true,
    }
  );
  fs.closeSync(output);
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null || spawnError)
      return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    for (
      let i = 0;
      i < 50 && child.exitCode === null && child.signalCode === null;
      i++
    )
      await delay(100);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  try {
    for (let i = 0; i < 300; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Source exited ${child.exitCode}; see ${log}`);
      try {
        const version = await fetch(
          `http://127.0.0.1:${port}/json/version`
        ).then((r) => r.json());
        const browser = await connect(version.webSocketDebuggerUrl);
        let page;
        const resources = new Map();
        let offset;
        const initialized = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("No attached main page")),
            30_000
          );
          browser.onEvent(async (event) => {
            if (event.method === "Target.attachedToTarget") {
              const { sessionId, targetInfo } = event.params;
              if (targetInfo.type !== "page" || page) {
                await browser
                  .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
                  .catch(() => {});
                return;
              }
              page = { sessionId, targetInfo };
              try {
                await browser.send("Network.enable", {}, sessionId);
                await browser.send("Page.enable", {}, sessionId);
                if (initScript)
                  await browser.send(
                    "Page.addScriptToEvaluateOnNewDocument",
                    { source: initScript },
                    sessionId
                  );
                await browser.send(
                  "Runtime.runIfWaitingForDebugger",
                  {},
                  sessionId
                );
                clearTimeout(timer);
                resolve(page);
              } catch (error) {
                clearTimeout(timer);
                reject(error);
              }
            }
            if (!page || event.sessionId !== page.sessionId) return;
            const params = event.params;
            if (event.method === "Network.requestWillBeSent") {
              offset = params.wallTime * 1000 - params.timestamp * 1000;
              resources.set(params.requestId, { url: params.request.url });
            }
            if (event.method === "Network.loadingFinished") {
              const resource = resources.get(params.requestId);
              if (resource && offset !== undefined)
                resource.loadedAt = params.timestamp * 1000 + offset;
            }
          });
        });
        await browser.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        const attached = await initialized;
        const send = (method, params = {}) =>
          browser.send(method, params, attached.sessionId);
        const cdp = {
          send,
          close: () => browser.close(),
          async evaluate(expression) {
            const result = await send("Runtime.evaluate", {
              expression,
              awaitPromise: true,
              returnByValue: true,
            });
            if (result.exceptionDetails)
              throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
          },
        };
        if (directPage) {
          const targets = await fetch(
            `http://127.0.0.1:${port}/json/list`
          ).then((r) => r.json());
          const target = targets.find(
            (t) => t.id === attached.targetInfo.targetId
          );
          if (!target) throw new Error("Attached source page vanished");
          const direct = await connect(target.webSocketDebuggerUrl);
          browser.close();
          return { child, spawnedAt, stop, cdp: direct, target, resources };
        }
        return {
          child,
          spawnedAt,
          stop,
          cdp,
          target: attached.targetInfo,
          resources,
        };
      } catch {}
      await delay(100);
    }
    throw new Error(`No main CDP target; see ${log}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
