// Shared types for skills management and the marketplace (api.skills.*).

export type SkillSource = "project" | "global" | "builtin";

type SkillInstallScope = "project" | "global";

export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  /** Absolute path to the skill file (`<id>.md` or `<id>/SKILL.md`). */
  path: string;
  source: SkillSource;
  argumentHint?: string;
}

/** A marketplace search result from skills.sh. */
export interface MarketplaceSkill {
  id: string;
  skillId: string;
  name: string;
  source: string;
  installs: number;
}

export interface ListInstalledSkillsRequest {
  /** Active workspace/session folder used to resolve project-scope skills. */
  workspacePath?: string;
}

export interface ListInstalledSkillsResult {
  skills: InstalledSkill[];
}

export interface SearchMarketplaceSkillsRequest {
  query: string;
}

export interface SearchMarketplaceSkillsResult {
  skills: MarketplaceSkill[];
  /**
   * Set when the request itself failed, so an outage differs from no matches.
   */
  error?: string;
}

export interface InstallSkillRequest {
  skillId: string;
  source: string;
  name: string;
  scope: SkillInstallScope;
  /** Required when scope === 'project'. */
  workspacePath?: string;
}

export interface SkillMutationResult {
  success: boolean;
  error?: string;
}

export interface RemoveSkillRequest {
  path: string;
  workspacePath?: string;
}

export interface OpenSkillFileRequest {
  path: string;
  /** Validates project-scope skill paths. */
  workspacePath?: string;
}

export interface ImportLocalSkillsRequest {
  /** 'file' opens a multi-select `.md` picker; 'folder' a directory picker. */
  kind: "file" | "folder";
}

export interface ImportLocalSkillsResult extends SkillMutationResult {
  imported?: number;
  cancelled?: boolean;
}
