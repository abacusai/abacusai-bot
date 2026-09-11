import anthropicMark from "@lobehub/icons-static-svg/icons/anthropic.svg";
import basetenMark from "@lobehub/icons-static-svg/icons/baseten.svg";
import cerebrasMark from "@lobehub/icons-static-svg/icons/cerebras-color.svg";
import deepSeekMark from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import fireworksMark from "@lobehub/icons-static-svg/icons/fireworks-color.svg";
import geminiMark from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import groqMark from "@lobehub/icons-static-svg/icons/groq.svg";
import huggingFaceMark from "@lobehub/icons-static-svg/icons/huggingface-color.svg";
import minimaxMark from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistralMark from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import moonshotMark from "@lobehub/icons-static-svg/icons/moonshot.svg";
import nvidiaMark from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import ollamaMark from "@lobehub/icons-static-svg/icons/ollama.svg";
import openAiMark from "@lobehub/icons-static-svg/icons/openai.svg";
import openCodeMark from "@lobehub/icons-static-svg/icons/opencode.svg";
import openRouterMark from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import togetherMark from "@lobehub/icons-static-svg/icons/together-color.svg";
import vercelMark from "@lobehub/icons-static-svg/icons/vercel.svg";
import xAiMark from "@lobehub/icons-static-svg/icons/xai.svg";
import zaiMark from "@lobehub/icons-static-svg/icons/zai.svg";
import { BrainCircuit, Cpu, Route } from "lucide-react";
import type { JSX } from "react";

import { cn } from "../../lib/cn";
import { AbacusBotMark } from "../brand/abacus-bot-logo";

type ProviderMarkProps = {
  provider: string;
  className?: string;
};

const COLOR_MARKS: Record<string, string> = {
  cerebras: cerebrasMark,
  deepseek: deepSeekMark,
  fireworks: fireworksMark,
  gemini: geminiMark,
  huggingface: huggingFaceMark,
  minimax: minimaxMark,
  mistral: mistralMark,
  nvidia: nvidiaMark,
  openrouter: openRouterMark,
  together: togetherMark,
};

const MONO_MARKS: Record<string, string> = {
  anthropic: anthropicMark,
  baseten: basetenMark,
  claude: anthropicMark,
  groq: groqMark,
  moonshotai: moonshotMark,
  ollama: ollamaMark,
  openai: openAiMark,
  "openai-codex": openAiMark,
  opencode: openCodeMark,
  vercel: vercelMark,
  "vercel-ai-gateway": vercelMark,
  xai: xAiMark,
  zai: zaiMark,
};

/** Brand marks used by the model picker, kept local by Vite after bundling. */
export const ProviderMark = ({
  provider,
  className,
}: ProviderMarkProps): JSX.Element => {
  const normalized = provider.toLowerCase();

  if (normalized === "abacus") {
    return <AbacusBotMark className={className} />;
  }

  if (normalized === "openllm") {
    return <Route className={className} aria-hidden="true" />;
  }

  const colorMark = COLOR_MARKS[normalized];
  if (colorMark != null) {
    return (
      <img
        src={colorMark}
        alt=""
        aria-hidden="true"
        className={cn("object-contain", className)}
      />
    );
  }

  const monoMark = MONO_MARKS[normalized];
  if (monoMark != null) {
    return (
      <img
        src={monoMark}
        alt=""
        aria-hidden="true"
        className={cn("object-contain dark:invert", className)}
      />
    );
  }

  const Fallback = normalized === "local" ? Cpu : BrainCircuit;
  return <Fallback className={className} aria-hidden="true" />;
};
