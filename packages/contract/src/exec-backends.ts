/**
 * Execution backends: where the agent's shell commands run. Local is the
 * default; a container or remote host is for commands less trusted than the
 * machine. Two are implemented; the rest are declared with what each needs so
 * the selector can say what is missing.
 */

export type BackendId =
  | "local"
  | "docker"
  | "singularity"
  | "modal"
  | "daytona"
  | "ssh";

export interface ExecBackend {
  id: BackendId;
  /** i18n key under `execBackends`. */
  labelKey: string;
  /** False when there is no runner for it yet. */
  implemented: boolean;
  /** Checked by the main process: a command on PATH, or env vars all set. */
  requires:
    | { kind: "none" }
    | { kind: "binary"; command: string }
    | { kind: "env"; vars: string[] };
}

export const EXEC_BACKENDS: ExecBackend[] = [
  {
    id: "local",
    labelKey: "local",
    implemented: true,
    requires: { kind: "none" },
  },
  {
    id: "docker",
    labelKey: "docker",
    implemented: true,
    requires: { kind: "binary", command: "docker" },
  },
  {
    id: "singularity",
    labelKey: "singularity",
    implemented: false,
    requires: { kind: "binary", command: "singularity" },
  },
  {
    id: "modal",
    labelKey: "modal",
    implemented: false,
    requires: { kind: "env", vars: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"] },
  },
  {
    id: "daytona",
    labelKey: "daytona",
    implemented: false,
    requires: { kind: "env", vars: ["DAYTONA_API_KEY"] },
  },
  {
    id: "ssh",
    labelKey: "ssh",
    implemented: false,
    requires: {
      kind: "env",
      vars: ["ABACUSAI_BOT_SSH_HOST", "ABACUSAI_BOT_SSH_USER"],
    },
  },
];

// Only backends with a runner are offered. The others stay in `EXEC_BACKENDS`
// so a stored id still resolves; a row that can never be picked looks broken.
export const SELECTABLE_EXEC_BACKENDS: ExecBackend[] = EXEC_BACKENDS.filter(
  (backend) => backend.implemented
);

export const DEFAULT_BACKEND: BackendId = "local";

// `unimplemented` stays apart from the missing-* kinds: one waits on us, the
// others on the user, and "needs setup" would send them hunting for nothing.
export type BackendBlocker =
  | { kind: "unimplemented" }
  | { kind: "unsupported-platform" }
  | { kind: "missing-binary"; command: string }
  | { kind: "missing-env"; vars: string[] };

export interface BackendStatus {
  id: BackendId;
  ready: boolean;
  blocker?: BackendBlocker;
}
