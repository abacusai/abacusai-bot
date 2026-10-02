import fs from "node:fs/promises";
import path from "node:path";
export interface BuildProvenance {
  commit: string;
  dirty: boolean;
  foundationApi: number;
  protocol: string;
  generation: "legacy" | "wco";
  builtAt: string;
}
export const readProvenance = async (
  file: string
): Promise<BuildProvenance> => {
  let value: Partial<BuildProvenance>;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new Error(`Missing or unreadable build provenance: ${file}`);
  }
  if (
    !value ||
    !/^[a-f0-9]{40,64}$/.test(value.commit ?? "") ||
    typeof value.dirty !== "boolean" ||
    !Number.isInteger(value.foundationApi) ||
    typeof value.protocol !== "string" ||
    !["legacy", "wco"].includes(value.generation ?? "") ||
    !Number.isFinite(Date.parse(value.builtAt ?? ""))
  )
    throw new Error(`Invalid build provenance: ${file}`);
  return value as BuildProvenance;
};
export const verifyProvenance = async (
  root: string,
  foundationApi: number,
  protocol: string
): Promise<BuildProvenance> => {
  const [renderer, agent] = await Promise.all([
    readProvenance(path.join(root, "renderer", "build.json")),
    readProvenance(path.join(root, "agent", "build.json")),
  ]);
  for (const build of [renderer, agent]) {
    if (
      build.foundationApi !== foundationApi ||
      build.protocol !== protocol ||
      build.generation !== (foundationApi >= 2 ? "wco" : "legacy")
    )
      throw new Error(
        "Build provenance names a different foundation API, protocol or generation"
      );
  }
  if (
    renderer.commit !== agent.commit ||
    renderer.foundationApi !== agent.foundationApi ||
    renderer.protocol !== agent.protocol
  )
    throw new Error("Renderer and agent build provenance disagree");
  return renderer;
};
