import {
  parsePptx as parseArchive,
  type ParseOptions,
} from "@abacus-ai/contract/pptx/parser";

import { ZipArchive } from "./zip";
export type { ParseOptions } from "@abacus-ai/contract/pptx/parser";
export function parsePptx(buffer: Buffer, options: ParseOptions = {}) {
  return parseArchive(ZipArchive.open(buffer), options);
}
