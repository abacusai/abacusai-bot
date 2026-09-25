import type { SkillMetadata } from "#shared/agent-types";

// Builtin skills would live under `~/.abacusai-bot/builtin-skills/<clientKind>/`.
// The bundled agent does not currently scan that directory, and the disk scan
// (api.skills.listInstalled) omits it too. This filter is kept as a defensive
// guard so that if an agent build ever reports builtins in its `skills_loaded`
// event (with `location` set to the skill file path), they still never appear
// in the user-facing slash picker.
const BUILTIN_LOCATION_RE = /[/\\]builtin-skills[/\\]/;

export function excludeBuiltinSkills(skills: SkillMetadata[]): SkillMetadata[] {
  return skills.filter((s) => !BUILTIN_LOCATION_RE.test(s.location ?? ""));
}

export function detectActiveSkills(
  message: string,
  skills: SkillMetadata[]
): string[] {
  if (!message.startsWith("/")) return [];
  const skillId = message.slice(1).split(/\s+/)[0];
  if (!skillId) return [];
  const match = skills.find((s) => s.id === skillId);
  return match ? [match.id] : [];
}

export function filterSkills(
  skills: SkillMetadata[],
  query: string
): SkillMetadata[] {
  if (!query) return skills;
  const q = query.toLowerCase();
  return skills.filter(
    (s) =>
      s.id.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
  );
}
