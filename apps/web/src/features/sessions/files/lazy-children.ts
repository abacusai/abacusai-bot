import type { FileTreeNode } from "@abacus-ai/contract/contracts";
import {
  useQueries,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";

export const MAX_LOADED_DIRECTORIES = 50;
export const useLazyChildren = (
  identity: string,
  revision: number,
  options: (directory: string) => UseQueryOptions<FileTreeNode[]>
) => {
  const [loaded, setLoaded] = useState({
    identity,
    paths: [] as string[],
  });
  const paths = loaded.identity === identity ? loaded.paths : [];
  const children = useQueries({
    queries: paths.map((directory) => {
      const query = options(directory);
      return {
        ...query,
        gcTime: 0,
      };
    }),
    combine: (results) =>
      results.flatMap((result) => (result.isError ? [] : (result.data ?? []))),
  });
  const qc = useQueryClient();
  const invalidate = useEffectEvent(() => {
    for (const directory of paths)
      void qc.invalidateQueries({ queryKey: options(directory).queryKey });
  });
  useEffect(() => {
    invalidate();
  }, [identity, revision]);
  return {
    children,
    load(directory: string) {
      setLoaded((previous) => {
        const paths = previous.identity === identity ? previous.paths : [];
        return {
          identity,
          paths: [
            ...paths.filter((path) => path !== directory),
            directory,
          ].slice(-MAX_LOADED_DIRECTORIES),
        };
      });
    },
  };
};
