import { type } from "@orpc/contract";
import * as v from "valibot";

import {
  ARTIFACT_ACCESS,
  type ArtifactPublished,
  type LivePage,
  type PagePreview,
  type ShareCreated,
  type SharedLink,
  type SharePreview,
} from "../share";
import { mutation, query } from "./base";
import { NoInput } from "./ids";

const ShareFile = v.object({ path: v.string(), lang: v.string() });

export const shares = {
  /** Renders the page and keeps nothing. */
  preview: mutation.input(ShareFile).output(type<SharePreview>()),
  create: mutation.input(ShareFile).output(type<ShareCreated>()),
  /** Null when signed out or the platform did not answer. */
  list: query.input(NoInput).output(type<SharedLink[] | null>()),
  remove: mutation
    .input(v.object({ shareId: v.string() }))
    .output(type<{ ok: boolean }>()),
  /** A web page, live: the same page updates the same link. */
  publishArtifact: mutation
    .input(v.object({ path: v.string(), access: v.picklist(ARTIFACT_ACCESS) }))
    .output(type<ArtifactPublished>()),
  unpublishArtifact: mutation
    .input(v.object({ identifier: v.string() }))
    .output(type<{ ok: boolean }>()),
  /** The live pages, newest first. Null when signed out or the platform did not answer. */
  pages: query.input(NoInput).output(type<LivePage[] | null>()),
  /** The page as its live link will show it; nothing leaves the computer. */
  previewPage: mutation
    .input(v.object({ path: v.string() }))
    .output(type<PagePreview>()),
  /** This file's live page, when it has one. */
  page: query
    .input(v.object({ path: v.string() }))
    .output(type<LivePage | null>()),
};
