/** Making cheap-model output presentable; leaked reasoning is reasoning-tags.ts. */

/** Final pass on a complete message: collapse padding, drop a leaked role label. */
export function tidyBotText(text: string): string {
  return text
    .replace(/^\s*(assistant|ai)\s*:\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "");
}
