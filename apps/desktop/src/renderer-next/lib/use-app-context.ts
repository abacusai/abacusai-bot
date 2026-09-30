import { ORPCError } from "@orpc/client";
import { useRouter } from "@tanstack/react-router";

import type { RouterContext } from "#next/router";
export const useAppContext = (): RouterContext =>
  useRouter().options.context as RouterContext;
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
