import { type } from "@orpc/contract";
import * as v from "valibot";

import type { ShareCreated, SharedLink, SharePreview } from "../share";
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
};
