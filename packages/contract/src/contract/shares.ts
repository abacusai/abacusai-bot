import { type } from "@orpc/contract";
import * as v from "valibot";

import {
  ARTIFACT_ACCESS,
  type ArtifactPublished,
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
  /** An artifact, live: the same page updates the same link. */
  publishArtifact: mutation
    .input(v.object({ path: v.string(), access: v.picklist(ARTIFACT_ACCESS) }))
    .output(type<ArtifactPublished>()),
  unpublishArtifact: mutation
    .input(v.object({ path: v.string() }))
    .output(type<{ ok: boolean }>()),
};
