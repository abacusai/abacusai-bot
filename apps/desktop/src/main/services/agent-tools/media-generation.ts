/**
 * Generating images, speech and video. Providers are detected from configured
 * keys, never picked by the user; everything returns a file path, never base64
 * (see generated-files.ts). Video takes minutes, so submit returns a job id
 * and a separate poll tool collects the result.
 */
import { credentialFor } from "../config/settings";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import { downloadGenerated, writeGenerated } from "./generated-files";

// Environment first, then Settings → API keys — this runs in the main process,
// where a Finder launch means an empty environment (see credentialFor).
const env = (name: string): string => credentialFor(name);

/**
 * Run the first configured provider, falling back to the next on failure. A
 * lone provider's error surfaces untouched; when all fail the aggregated error
 * names every attempt.
 */
const firstConfigured = async <T>(
  what: string,
  attempts: Array<{ id: string; configured: boolean; run: () => Promise<T> }>,
  setupHint: string
): Promise<T> => {
  const usable = attempts.filter((attempt) => attempt.configured);

  if (usable.length === 0)
    throw new Error(`No ${what} provider is configured. ${setupHint}`);
  if (usable.length === 1) return await usable[0].run();

  const failures: string[] = [];

  for (const attempt of usable) {
    try {
      return await attempt.run();
    } catch (error) {
      failures.push(
        `${attempt.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw new Error(
    `Every configured ${what} provider failed. ${failures.join("; ")}`
  );
};

const request = async (
  url: string,
  init: RequestInit,
  timeoutMs = 180_000
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });

    if (!response.ok) {
      throw new Error(
        `${response.status} ${response.statusText}: ${(await response.text()).slice(0, 400)}`
      );
    }

    return response;
  } finally {
    clearTimeout(timer);
  }
};

const postJson = async (
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs?: number
): Promise<unknown> =>
  await (
    await request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      },
      timeoutMs
    )
  ).json();

// ── Abacus.AI (RouteLLM API) ───────────────────────────────────────────────
//
// One ABACUS_API_KEY covers image and speech through chat/completions with
// `modalities`; results arrive base64 in message.images / message.audios.

const abacusChat = async (
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<{
  choices?: Array<{
    message?: {
      images?: Array<{ image_url?: { url?: string } }>;
      audios?: Array<{ data?: string; format?: string }>;
    };
  }>;
}> =>
  (await postJson(
    `${abacusRoutellmV1()}/chat/completions`,
    { Authorization: `Bearer ${env("ABACUS_API_KEY")}` },
    payload,
    timeoutMs
  )) as {
    choices?: Array<{
      message?: {
        images?: Array<{ image_url?: { url?: string } }>;
        audios?: Array<{ data?: string; format?: string }>;
      };
    }>;
  };

// Extensions come from a fixed allowlist, never the provider's MIME subtype:
// the path is handed to the UI, where a click opens it.
const IMAGE_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
// Refused rather than buffered, so a hostile response cannot OOM the main process.
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

const dataUrlToFile = async (
  kind: string,
  dataUrl: string
): Promise<string> => {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);

  if (match == null) {
    // Claw-style keys get a plain CDN URL here instead of a data URL.
    if (/^https:\/\//i.test(dataUrl))
      return await downloadGenerated(kind, "png", dataUrl);

    throw new Error("The provider returned an unrecognized media payload.");
  }

  // 4 base64 chars = 3 bytes; bound the decode before allocating.
  if (match[2].length > (MAX_MEDIA_BYTES / 3) * 4)
    throw new Error("The provider returned an oversized media payload.");

  const ext = IMAGE_EXTS[match[1].toLowerCase()] ?? "png";

  return writeGenerated(kind, ext, Buffer.from(match[2], "base64"));
};

// ── Images ─────────────────────────────────────────────────────────────────

export const generateImage = async (
  prompt: string,
  size?: string
): Promise<string> =>
  await firstConfigured(
    "image",
    [
      {
        id: "abacus",
        configured: env("ABACUS_API_KEY").length > 0,
        run: async () => {
          const body = await abacusChat(
            {
              model: env("ABACUSAI_BOT_ABACUS_IMAGE_MODEL") || "nano_banana",
              messages: [{ role: "user", content: prompt }],
              modalities: ["image"],
            },
            300_000
          );
          const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url;

          if (url == null) throw new Error("The provider returned no image.");

          return await dataUrlToFile("image", url);
        },
      },
      {
        id: "openai",
        configured: env("OPENAI_API_KEY").length > 0,
        run: async () => {
          const body = (await postJson(
            "https://api.openai.com/v1/images/generations",
            { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
            {
              model: env("ABACUSAI_BOT_IMAGE_MODEL") || "gpt-image-2",
              prompt,
              size: size ?? "1024x1024",
              n: 1,
            }
          )) as { data?: Array<{ b64_json?: string; url?: string }> };

          const first = body.data?.[0];

          if (first?.b64_json != null)
            return writeGenerated(
              "image",
              "png",
              Buffer.from(first.b64_json, "base64")
            );
          if (first?.url != null)
            return await downloadGenerated("image", "png", first.url);

          throw new Error("The provider returned no image.");
        },
      },
      {
        id: "fal",
        configured: env("FAL_KEY").length > 0,
        run: async () => {
          // FAL takes size enums or {width,height}, not the "1024x1024" string.
          const requested = (size ?? "square_hd").trim();
          const dims = /^\d+x\d+$/.test(requested)
            ? {
                width: Number(requested.split("x")[0]),
                height: Number(requested.split("x")[1]),
              }
            : requested;

          const body = (await postJson(
            `https://fal.run/${env("ABACUSAI_BOT_IMAGE_MODEL") || "fal-ai/flux/schnell"}`,
            { Authorization: `Key ${env("FAL_KEY")}` },
            { prompt, image_size: dims }
          )) as { images?: Array<{ url?: string; content_type?: string }> };

          const first = body.images?.[0];

          if (first?.url == null)
            throw new Error("The provider returned no image.");

          // FLUX answers JPEG by default; name the file for what it is.
          const contentType = first.content_type ?? "";
          const ext = /jpe?g/.test(contentType)
            ? "jpg"
            : contentType.includes("webp")
              ? "webp"
              : "png";

          return await downloadGenerated("image", ext, first.url);
        },
      },
    ],
    "The user can connect Abacus.AI (ABACUS_API_KEY) or add OPENAI_API_KEY or FAL_KEY in Settings → API keys (or the environment). Tell the user image generation is unavailable until then."
  );

// ── Speech ─────────────────────────────────────────────────────────────────

export const generateSpeech = async (
  text: string,
  voice?: string
): Promise<string> =>
  await firstConfigured(
    "speech",
    [
      {
        id: "abacus",
        configured: env("ABACUS_API_KEY").length > 0,
        run: async () => {
          // Gemini TTS accepts the OpenAI voice aliases too, so `voice` passes through.
          const body = await abacusChat(
            {
              model:
                env("ABACUSAI_BOT_ABACUS_TTS_MODEL") ||
                "gemini-2.5-flash-preview-tts",
              messages: [{ role: "user", content: text }],
              modalities: ["audio"],
              audio: { voice: voice ?? "alloy" },
            },
            300_000
          );
          const audio = body.choices?.[0]?.message?.audios?.[0];

          if (audio?.data == null)
            throw new Error("The provider returned no audio.");
          if (audio.data.length > (MAX_MEDIA_BYTES / 3) * 4)
            throw new Error(
              "The provider returned an oversized audio payload."
            );

          // Extension from a fixed allowlist, never the provider's format.
          const format = (audio.format ?? "wav").toLowerCase();
          const ext =
            format === "mpeg" || format === "mp3"
              ? "mp3"
              : format === "pcm" || format === "wav"
                ? "wav"
                : format === "ogg" || format === "opus"
                  ? "ogg"
                  : "wav";

          return writeGenerated(
            "speech",
            ext,
            Buffer.from(audio.data, "base64")
          );
        },
      },
      {
        id: "openai",
        configured: env("OPENAI_API_KEY").length > 0,
        run: async () => {
          const response = await request(
            "https://api.openai.com/v1/audio/speech",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
              },
              body: JSON.stringify({
                model: env("ABACUSAI_BOT_TTS_MODEL") || "gpt-4o-mini-tts",
                voice: voice ?? "alloy",
                input: text,
              }),
            }
          );

          return writeGenerated(
            "speech",
            "mp3",
            Buffer.from(await response.arrayBuffer())
          );
        },
      },
      {
        id: "elevenlabs",
        configured: env("ELEVENLABS_API_KEY").length > 0,
        run: async () => {
          // ElevenLabs keys voices by id, so the default is their standard public voice.
          const voiceId = voice ?? "21m00Tcm4TlvDq8ikWAM";
          const response = await request(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "xi-api-key": env("ELEVENLABS_API_KEY"),
              },
              body: JSON.stringify({
                text,
                model_id: "eleven_multilingual_v2",
              }),
            }
          );

          return writeGenerated(
            "speech",
            "mp3",
            Buffer.from(await response.arrayBuffer())
          );
        },
      },
    ],
    "The user can connect Abacus.AI (ABACUS_API_KEY) or add OPENAI_API_KEY or ELEVENLABS_API_KEY in Settings → API keys (or the environment). Tell the user speech generation is unavailable until then."
  );

// ── Video ──────────────────────────────────────────────────────────────────

/**
 * In-flight video jobs, so a poll can explain an unknown id. In memory: a job
 * that outlives the app is one nobody is waiting for.
 */
const videoJobs = new Map<
  string,
  {
    provider: "fal" | "bfl";
    pollUrl: string;
    /** FAL only: where the result lives; the status URL never carries it. */
    responseUrl?: string;
    submittedAt: number;
  }
>();

let jobCounter = 0;

const rememberJob = (
  provider: "fal" | "bfl",
  pollUrl: string,
  responseUrl?: string
): string => {
  const id = `${provider}-${++jobCounter}`;
  videoJobs.set(id, {
    provider,
    pollUrl,
    ...(responseUrl != null ? { responseUrl } : {}),
    submittedAt: Date.now(),
  });

  return id;
};

export const submitVideo = async (payload: {
  prompt: string;
  imageUrl?: string;
  keyframes?: string[];
  continueFrom?: string;
}): Promise<string> =>
  await firstConfigured(
    "video",
    [
      {
        id: "bfl",
        configured: env("BFL_API_KEY").length > 0,
        run: async () => {
          const body = (await postJson(
            `https://api.bfl.ai/v1/${env("ABACUSAI_BOT_VIDEO_MODEL") || "flux-3-video"}`,
            { "x-key": env("BFL_API_KEY") },
            {
              prompt: payload.prompt,
              ...(payload.imageUrl != null
                ? { image_url: payload.imageUrl }
                : {}),
              ...(payload.keyframes != null
                ? { keyframes: payload.keyframes }
                : {}),
              ...(payload.continueFrom != null
                ? { video_url: payload.continueFrom }
                : {}),
            }
          )) as { id?: string; polling_url?: string };

          if (body.polling_url == null && body.id == null)
            throw new Error("The provider returned no job id.");

          return rememberJob(
            "bfl",
            body.polling_url ?? `https://api.bfl.ai/v1/get_result?id=${body.id}`
          );
        },
      },
      {
        id: "fal",
        configured: env("FAL_KEY").length > 0,
        run: async () => {
          // The FAL request carries neither keyframes nor a source video;
          // dropping them silently would return an unrelated clip as a success.
          if (payload.keyframes != null || payload.continueFrom != null) {
            throw new Error(
              "The FAL video backend cannot honor keyframes or continue an existing video. " +
                "Those need BFL_API_KEY — despite their names, the xai_video_* tools run on BFL or FAL, not xAI."
            );
          }

          const body = (await postJson(
            `https://queue.fal.run/${env("ABACUSAI_BOT_VIDEO_MODEL") || "fal-ai/kling-video/v1/standard/text-to-video"}`,
            { Authorization: `Key ${env("FAL_KEY")}` },
            {
              prompt: payload.prompt,
              ...(payload.imageUrl != null
                ? { image_url: payload.imageUrl }
                : {}),
            }
          )) as {
            status_url?: string;
            response_url?: string;
            request_id?: string;
          };

          if (body.status_url == null)
            throw new Error("The provider returned no job id.");

          return rememberJob("fal", body.status_url, body.response_url);
        },
      },
    ],
    "The user can add BFL_API_KEY or FAL_KEY in Settings → API keys (or the environment); the xai_video_* tools run on these providers, not on xAI. Tell the user video generation is unavailable until then."
  );

export const pollVideo = async (
  jobId: string
): Promise<{ done: boolean; message: string }> => {
  const job = videoJobs.get(jobId);

  if (job == null) {
    return {
      done: false,
      message: `No job "${jobId}" is in flight. Jobs are forgotten when the app restarts; submit again.`,
    };
  }

  const headers =
    job.provider === "bfl"
      ? { "x-key": env("BFL_API_KEY") }
      : { Authorization: `Key ${env("FAL_KEY")}` };
  const body = (await (
    await request(job.pollUrl, { headers }, 60_000)
  ).json()) as {
    status?: string;
    result?: { sample?: string; video?: { url?: string } };
    video?: { url?: string };
  };

  const status = (body.status ?? "").toLowerCase();
  let url = body.result?.sample ?? body.result?.video?.url ?? body.video?.url;

  // FAL's status endpoint never carries the result: on COMPLETED it lives at
  // the response URL from submit time, and may still be an error.
  if (url == null && job.provider === "fal" && status === "completed") {
    videoJobs.delete(jobId);

    if (job.responseUrl == null) {
      return {
        done: true,
        message:
          "The job completed, but the provider gave no response URL to fetch the result from.",
      };
    }

    const payload = (await (
      await request(job.responseUrl, { headers }, 60_000)
    ).json()) as {
      video?: { url?: string };
      url?: string;
      error?: unknown;
      detail?: unknown;
    };

    url = payload.video?.url ?? payload.url;

    if (url == null || payload.error != null) {
      return {
        done: true,
        message: `The job completed with an error: ${JSON.stringify(payload).slice(0, 300)}`,
      };
    }

    return {
      done: true,
      message: await downloadGenerated("video", "mp4", url),
    };
  }

  if (url != null) {
    videoJobs.delete(jobId);

    return {
      done: true,
      message: await downloadGenerated("video", "mp4", url),
    };
  }

  if (status.includes("error") || status.includes("fail")) {
    videoJobs.delete(jobId);

    return {
      done: true,
      message: `The job failed: ${JSON.stringify(body).slice(0, 300)}`,
    };
  }

  const waited = Math.round((Date.now() - job.submittedAt) / 1000);

  return {
    done: false,
    message: `Still running (${status || "pending"}), ${waited}s so far. Poll again shortly.`,
  };
};

/** Guidance the model can read instead of guessing at prompt structure. */
export const videoPromptingGuide = (): string =>
  [
    "Writing prompts for video generation:",
    "",
    "- Describe the shot, not just the subject: framing, camera move, and lens.",
    '  "slow dolly in on a rain-streaked window, shallow depth of field" beats "a window".',
    "- Say what moves. A prompt with no motion in it produces a near-still clip.",
    '- Put the subject first, style last. Leading with "cinematic, 4k, trending" spends',
    "  the strongest part of the prompt on adjectives the model applies loosely anyway.",
    "- Keep it to one continuous action. Two actions usually produce a hard cut or a blend.",
    "- Negatives are weak in most video models — describe what you do want instead.",
    "",
    "Generation takes minutes. Submit, then poll with bfl_flux3_get_result.",
  ].join("\n");
