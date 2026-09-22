/**
 * The models the app can download and run on this machine, served by the
 * bundled llama.cpp server. Read by both processes: main downloads and serves
 * them, the renderer offers them.
 *
 * Each row is one GGUF file, pinned by digest: it is executed by a native
 * runtime on the user's machine, so a floating "latest" is not an option. All
 * three are instruction-tuned Qwen builds that drive an agent loop — tool
 * calling and a 32k context are the bar, not benchmark scores — at the 4-bit
 * quantisation that fits the memory they are recommended for.
 */

/** The custom-provider id the local runtime registers under. */
export const LOCAL_PROVIDER_ID = "local";

/** The context each local model is served with; a transcript outgrows less. */
export const LOCAL_MODEL_CONTEXT = 32_768;

export interface LocalModelSpec {
  /** Stable id, also the alias the server answers to. */
  id: string;
  label: string;
  /** Hugging Face repository and file. */
  repo: string;
  file: string;
  sha256: string;
  sizeBytes: number;
  /** The least total memory this is offered on. */
  minMemoryBytes: number;
}

const GB = 1024 ** 3;

export const LOCAL_MODEL_CATALOG: LocalModelSpec[] = [
  {
    id: "qwen3.5-4b",
    label: "Qwen 3.5 4B",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    sizeBytes: 2_740_937_888,
    minMemoryBytes: 6 * GB,
  },
  {
    id: "qwen3.5-9b",
    label: "Qwen 3.5 9B",
    repo: "unsloth/Qwen3.5-9B-GGUF",
    file: "Qwen3.5-9B-Q4_K_M.gguf",
    sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
    sizeBytes: 5_680_522_464,
    minMemoryBytes: 12 * GB,
  },
  {
    id: "qwen3.6-27b",
    label: "Qwen 3.6 27B",
    repo: "unsloth/Qwen3.6-27B-GGUF",
    file: "Qwen3.6-27B-Q4_K_M.gguf",
    sha256: "5ed60d0af4650a854b1755bd392f9aef4872643dc25a254bc68043fa638392a0",
    sizeBytes: 16_817_244_384,
    minMemoryBytes: 32 * GB,
  },
];

export const localModelSpec = (id: string): LocalModelSpec | undefined =>
  LOCAL_MODEL_CATALOG.find((spec) => spec.id === id);

/** The model reference the picker and the agent use: `local/<id>`. */
export const localModelReference = (id: string): string =>
  `${LOCAL_PROVIDER_ID}/${id}`;

/**
 * The largest model the machine's memory allows, or the smallest when even
 * that is tight: a slow answer beats none, and the dialog says so.
 */
export const recommendLocalModel = (totalMemoryBytes: number): LocalModelSpec =>
  [...LOCAL_MODEL_CATALOG]
    .reverse()
    .find((spec) => spec.minMemoryBytes <= totalMemoryBytes) ??
  LOCAL_MODEL_CATALOG[0]!;

/** The download URL Hugging Face serves the file from. */
export const localModelUrl = (spec: LocalModelSpec): string =>
  `https://huggingface.co/${spec.repo}/resolve/main/${spec.file}`;

export type LocalModelPhase =
  | "downloading"
  | "verifying"
  | "ready"
  | "failed"
  | "cancelled";

/** One download's progress, as the renderer sees it. */
export interface LocalModelProgress {
  modelId: string;
  phase: LocalModelPhase;
  receivedBytes: number;
  totalBytes: number;
  error?: string;
}

/** What the machine can do with local models right now. */
export interface LocalModelState {
  /** False when the app was built without the server for this platform. */
  runtimeAvailable: boolean;
  totalMemoryBytes: number;
  recommendedId: string;
  catalog: LocalModelSpec[];
  installedIds: string[];
  /** The download in flight, if any. */
  download: LocalModelProgress | null;
  /** The model currently loaded in memory, if any. */
  servingId: string | null;
}
