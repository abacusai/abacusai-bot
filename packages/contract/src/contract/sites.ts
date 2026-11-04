import { type } from "@orpc/contract";
import * as v from "valibot";

import type { SitePack, SitePackProgress } from "../site-deploy";
import { mutation, query } from "./base";

const Id = v.pipe(v.string(), v.nonEmpty(), v.maxLength(200));

/** A chat's site, zipped for Abacus AI Agent on the web (site-deploy.ts). */
export const sites = {
  /** Zips the chat's latest site; `packId` names the run for progress and cancel. */
  pack: mutation
    .input(v.object({ sessionId: Id, packId: Id }))
    .output(type<SitePack>()),
  progress: query
    .input(v.object({ packId: Id }))
    .output(type<SitePackProgress | null>()),
  cancel: mutation.input(v.object({ packId: Id })).output(type<void>()),
  /** Drags a zip the app made out of the window, into a browser's upload. */
  startDrag: mutation
    .input(v.object({ path: v.pipe(v.string(), v.nonEmpty()) }))
    .output(type<void>()),
};
