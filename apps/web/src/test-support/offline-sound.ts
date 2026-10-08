import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { rolldown } from "rolldown";
import WebSocket from "ws";

export const chrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path) => path && existsSync(path));

interface Tone {
  at: number;
  duration: number;
  from: number;
  to?: number;
  gain: number;
  type?: OscillatorType;
}
export interface Levels {
  peak: number;
  rms: number;
  duration: number;
}
export interface RenderedCues {
  cues: Record<string, { before: Levels; after: Levels }>;
  overload: Levels;
}
export const renderSoundLevels = async (
  current: Readonly<Record<string, readonly Tone[]>>,
  previous: Readonly<Record<string, readonly Tone[]>>
): Promise<RenderedCues> => {
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
        const previous = ${JSON.stringify(previous)};
        const current = ${JSON.stringify(current)};
        for (const [cue, tones] of Object.entries(current)) {
          result[cue] = {
            before: await render(previous[cue] ?? tones, false),
            after: await render(tones, true),
          };
        }
        const overload = await render(Array.from({ length: 40 }, () => ({ at: 0, duration: 0.1, from: 660, gain: 0.4 })), true);
        return { cues: result, overload };
      })();`,
      },
      sessionId
    );
    if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
    const result = rendered.value as RenderedCues;
    if (process.env.SOUND_MEASUREMENTS_PATH)
      await writeFile(
        process.env.SOUND_MEASUREMENTS_PATH,
        JSON.stringify(result)
      );
    return result;
  } finally {
    socket?.close();
    const exited = once(browserProcess, "exit");
    browserProcess.kill();
    await exited;
    await bundle.close();
    await rm(scratch, { recursive: true, force: true });
  }
};
