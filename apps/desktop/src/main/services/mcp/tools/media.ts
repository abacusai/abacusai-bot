import { videoPromptingGuide } from "../../agent-tools/media-generation";
import type { ToolDefinition } from "./definition";

/**
 * Understanding and generating images, audio and video.
 */
export const MEDIA_TOOLS: ToolDefinition[] = [
  {
    name: "vision_analyze",
    toolsets: ["vision"],
    description:
      "Look at an image and answer a question about it. Accepts a local file path or an http(s) URL.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Image path or URL." },
        prompt: {
          type: "string",
          description:
            "What you want to know. Defaults to a general description.",
        },
      },
      required: ["source"],
    },
    run: (host, args) => host.analyze(args, "image"),
  },
  {
    name: "video_analyze",
    toolsets: ["video"],
    description:
      "Watch a video and answer a question about it. Needs a video-capable model — not every vision provider accepts video.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Video path or URL." },
        prompt: { type: "string", description: "What you want to know." },
      },
      required: ["source"],
    },
    run: (host, args) => host.analyze(args, "video"),
  },
  {
    name: "image_generate",
    toolsets: ["image_gen"],
    description:
      "Generate an image from a prompt. Returns the path to the saved file, which you should show to the user as a markdown image so it renders in the chat. Never link to an image on a third-party site instead of generating one.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: {
          type: "string",
          description: 'Provider-specific, e.g. "1024x1024".',
        },
      },
      required: ["prompt"],
    },
    run: (host, args) => host.imageGenerate(args),
  },
  {
    name: "text_to_speech",
    toolsets: ["tts"],
    description:
      "Turn text into spoken audio. Returns the path to the saved file.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        voice: {
          type: "string",
          description: "Provider-specific voice name or id.",
        },
      },
      required: ["text"],
    },
    run: (host, args) => host.textToSpeech(args),
  },
  {
    name: "video_generate",
    toolsets: ["video_gen"],
    description:
      "Start generating a video from a prompt, optionally driven by a still image. Returns a job id — generation takes minutes, so poll with bfl_flux3_get_result.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        image_url: {
          type: "string",
          description: "Optional still to animate.",
        },
      },
      required: ["prompt"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "xai_video_edit",
    toolsets: ["video_gen"],
    description:
      "Re-generate an existing video against a new prompt. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, video_url: { type: "string" } },
      required: ["prompt", "video_url"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "xai_video_extend",
    toolsets: ["video_gen"],
    description:
      "Continue an existing video past its end. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, video_url: { type: "string" } },
      required: ["prompt", "video_url"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_text_to_video",
    toolsets: ["bfl"],
    description:
      "Start a video generation from a prompt alone. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_image_to_video",
    toolsets: ["bfl"],
    description:
      "Start a video generation from a still image. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, image_url: { type: "string" } },
      required: ["prompt", "image_url"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_keyframes_to_video",
    toolsets: ["bfl"],
    description:
      "Start a video generation that passes through given keyframes. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        keyframes: {
          type: "array",
          items: { type: "string" },
          description: "Image URLs, in order.",
        },
      },
      required: ["prompt", "keyframes"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_video_continuation",
    toolsets: ["bfl"],
    description: "Continue an existing video. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, video_url: { type: "string" } },
      required: ["prompt", "video_url"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_get_result",
    toolsets: ["bfl", "video_gen"],
    description:
      "Check a video job. Returns the file path once it is done, or how long it has been running. Poll every 20-30 seconds rather than in a tight loop.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
    run: (host, args) => host.pollVideoJob(args),
  },
  {
    name: "bfl_flux3_prompting_guide",
    toolsets: ["bfl", "video_gen"],
    description:
      "Read guidance on writing video prompts before generating. Costs nothing and improves results.",
    inputSchema: { type: "object", properties: {} },
    run: (host) => host.ok(videoPromptingGuide()),
  },
];
