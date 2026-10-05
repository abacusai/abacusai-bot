import type { SystemInfo } from "@abacus-ai/contract/contract";
import { ORPCError } from "@orpc/client";
import { useRouter } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";

import type { RouterContext } from "#renderer/router";
export const useAppContext = (): RouterContext =>
  useRouter().options.context as RouterContext;
/**
 * The host's system facts. On the web a placeholder until the host answers
 * `system.info` (spec 09 D12); the component re-renders then.
 */
export const useSystem = (): SystemInfo =>
  useSelector(useAppContext().system, (system) => system);
export const foldSearch = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const rpcError = (
  error: unknown
): {
  code: string;
  data: { field?: string; detail?: string; reason?: string };
} | null =>
  error instanceof ORPCError && error.defined
    ? {
        code: error.code,
        data: (error.data ?? {}) as {
          field?: string;
          detail?: string;
          reason?: string;
        },
      }
    : null;
