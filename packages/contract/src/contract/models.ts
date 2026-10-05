import { type } from "@orpc/contract";
import * as v from "valibot";

import type { ModelAvailability } from "../models";
import { query } from "./base";

export const models = {
  list: query
    .input(v.optional(v.object({ refresh: v.optional(v.boolean()) })))
    .output(type<ModelAvailability[]>()),
};
