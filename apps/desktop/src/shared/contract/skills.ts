import { type } from "@orpc/contract";
import * as v from "valibot";

import type {
  ImportLocalSkillsResult,
  ListInstalledSkillsResult,
  SearchMarketplaceSkillsResult,
  SkillMutationResult,
} from "../skills-types";
import { mutation, query } from "./base";

export const ListInstalledSkillsRequestSchema = v.object({
  workspacePath: v.optional(v.string()),
});

export const SearchMarketplaceSkillsRequestSchema = v.object({
  query: v.string(),
});

export const InstallSkillRequestSchema = v.object({
  skillId: v.pipe(v.string(), v.nonEmpty()),
  source: v.pipe(v.string(), v.nonEmpty()),
  name: v.pipe(v.string(), v.nonEmpty()),
  scope: v.picklist(["project", "global"]),
  workspacePath: v.optional(v.string()),
});

export const RemoveSkillRequestSchema = v.object({
  path: v.pipe(v.string(), v.nonEmpty()),
  workspacePath: v.optional(v.string()),
});

export const OpenSkillFileRequestSchema = RemoveSkillRequestSchema;

export const ImportLocalSkillsRequestSchema = v.object({
  kind: v.picklist(["file", "folder"]),
});

export const skills = {
  listInstalled: query
    .input(v.optional(ListInstalledSkillsRequestSchema))
    .output(type<ListInstalledSkillsResult>()),
  search: query
    .input(SearchMarketplaceSkillsRequestSchema)
    .output(type<SearchMarketplaceSkillsResult>()),
  install: mutation
    .input(InstallSkillRequestSchema)
    .output(type<SkillMutationResult>()),
  remove: mutation
    .input(RemoveSkillRequestSchema)
    .output(type<SkillMutationResult>()),
  openFile: mutation
    .input(OpenSkillFileRequestSchema)
    .output(type<SkillMutationResult>()),
  /** Opens a picker in main; always global scope. */
  importLocal: mutation
    .input(ImportLocalSkillsRequestSchema)
    .output(type<ImportLocalSkillsResult>()),
};
