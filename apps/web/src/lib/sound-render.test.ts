import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { rolldown } from "rolldown";
import { expect, it } from "vitest";
import WebSocket from "ws";

const chrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path) => path && existsSync(path));

it.skipIf(!chrome)(
  "renders chat cues with native OfflineAudioContext",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "bot-sound-render-"));
    const bundle = await rolldown({
      input: resolve("src/lib/sound.ts"),
    });
    const browserProcess = spawn(
      chrome!,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-background-networking",
        "--remote-debugging-port=0",
        `--user-data-dir=${join(scratch, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let socket: WebSocket | undefined;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(
          () => reject(new Error("Chrome did not start")),
          15000
        );
        browserProcess.stderr!.on("data", (chunk) => {
          stderr += chunk.toString();
          const endpoint = stderr.match(
            /DevTools listening on (ws:\/\/\S+)/
          )?.[1];
          if (endpoint) {
            clearTimeout(timer);
            resolve(endpoint);
          }
        });
        browserProcess.once("error", reject);
      });
      socket = new WebSocket(url);
      await once(socket, "open");
      let id = 0;
      const request = (
        method: string,
        params: object = {},
        sessionId?: string
      ): Promise<any> =>
        new Promise((resolve, reject) => {
          const requestId = ++id;
          const receive = (data: WebSocket.RawData) => {
            const message = JSON.parse(data.toString());
            if (message.id !== requestId) return;
            socket!.off("message", receive);
            if (message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve(message.result);
          };
          socket!.on("message", receive);
          socket!.send(
            JSON.stringify({ id: requestId, method, params, sessionId })
          );
        });
      const { targetId } = await request("Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = await request("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const { output } = await bundle.generate({
        format: "iife",
        name: "Sound",
      });
      const { result: rendered, exceptionDetails } = await request(
        "Runtime.evaluate",
        {
          awaitPromise: true,
          returnByValue: true,
          expression: `${output[0]!.code}
      const render = async (tones, limited) => {
        const audio = new OfflineAudioContext(1, 24000, 48000);
        if (!limited) {
          // The previous player connected envelopes straight to destination.
          audio.createWaveShaper = () => {
            const bypass = audio.createGain();
            return bypass;
          };
        }
        Sound.synthTones(audio, tones, 0.02);
        const samples = (await audio.startRendering()).getChannelData(0);
        let peak = 0, energy = 0, end = 0;
        for (let i = 0; i < samples.length; i++) {
          peak = Math.max(peak, Math.abs(samples[i]));
          energy += samples[i] * samples[i];
          if (Math.abs(samples[i]) > 0.0002) end = i / 48000;
        }
        return { peak, rms: Math.sqrt(energy / samples.length), duration: end - 0.02 };
      };
      (async () => {
        const result = {};
        const previous = {
          pop: [{ at: 0, duration: 0.06, from: 520, to: 780, gain: 0.018 }],
          step: [{ at: 0, duration: 0.09, from: 660, gain: 0.018 }, { at: 0.1, duration: 0.09, from: 880, gain: 0.015 }],
          celebrate: [523, 659, 784].map((from, index) => ({ at: index * 0.08, duration: 0.12, from, gain: 0.015 })),
          sent: [{ at: 0, duration: 0.09, from: 660, to: 880, gain: 0.08 }],
          received: [{ at: 0, duration: 0.07, from: 880, gain: 0.07 }, { at: 0.11, duration: 0.07, from: 1175, gain: 0.07 }],
          done: [{ at: 0, duration: 0.09, from: 523, gain: 0.08 }, { at: 0.12, duration: 0.09, from: 784, gain: 0.08 }],
        };
        for (const [cue, tones] of Object.entries({ ...Sound.CUE_TONES, ...Sound.INTERACTION_TONES })) {
          result[cue] = {
            before: await render(previous[cue] ?? tones, false),
            after: await render(tones, true),
          };
        }
        result.overload = await render(Array.from({ length: 40 }, () => ({ at: 0, duration: 0.1, from: 660, gain: 0.4 })), true);
        return result;
      })();`,
        },
        sessionId
      );
      expect(exceptionDetails).toBeUndefined();
      const result = rendered.value;
      if (process.env.SOUND_MEASUREMENTS_PATH)
        await writeFile(
          process.env.SOUND_MEASUREMENTS_PATH,
          JSON.stringify(result)
        );
      for (const { after } of Object.values(result) as Array<{
        after?: { peak: number; rms: number; duration: number };
      }>) {
        if (!after) continue;
        expect(after.peak).toBeLessThanOrEqual(Math.SQRT1_2 + 0.001);
        expect(after.rms).toBeGreaterThan(0.001);
        expect(after.duration).toBeGreaterThan(0.04);
        expect(after.duration).toBeLessThan(0.32);
      }
      for (const cue of ["pop", "step", "celebrate"]) {
        if (!result[cue]) continue;
        expect(result[cue].after.rms / result[cue].before.rms).toBeGreaterThan(
          1.85
        );
        expect(result[cue].after.rms / result[cue].before.rms).toBeLessThan(
          2.1
        );
      }
      expect(
        result.received.after.peak / result.received.before.peak
      ).toBeGreaterThan(1.7);
      expect(
        result.received.after.peak / result.received.before.peak
      ).toBeLessThan(2);
      expect(result.sent.after.duration).toBeGreaterThan(0.12);
      expect(result.sent.after.duration).toBeLessThan(0.2);
      expect(result.sent.after.rms / result.sent.before.rms).toBeGreaterThan(
        1.4
      );
      expect(result.done.after.peak / result.done.before.peak).toBeGreaterThan(
        1.7
      );
      expect(result.done.after.peak / result.done.before.peak).toBeLessThan(2);
      expect(result.done.after.rms / result.done.before.rms).toBeGreaterThan(
        1.8
      );
      expect(result.done.after.rms / result.done.before.rms).toBeLessThan(2.3);
      expect(result.done.after.duration).toBeGreaterThan(0.24);
      expect(result.overload.peak).toBeLessThanOrEqual(Math.SQRT1_2 + 0.001);
      console.info(
        "OfflineAudioContext levels (RMS over 500 ms):",
        JSON.stringify(result)
      );
    } finally {
      socket?.close();
      const exited = once(browserProcess, "exit");
      browserProcess.kill();
      await exited;
      await bundle.close();
      await rm(scratch, { recursive: true, force: true });
    }
  },
  45000
);
