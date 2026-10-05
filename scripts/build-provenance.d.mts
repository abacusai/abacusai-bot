export interface BuildConstants {
  foundationApi: number;
  protocol: string;
  generation: "legacy" | "wco";
}
export interface BuildProvenance extends BuildConstants {
  commit: string;
  dirty: boolean;
  builtAt: string;
}
export function buildConstants(): BuildConstants;
export function buildProvenance(env?: NodeJS.ProcessEnv): BuildProvenance;
export function writeBuildProvenance(directory: string): void;
