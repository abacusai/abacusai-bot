import { useQueries, type UseQueryOptions } from "@tanstack/react-query";
import { useState } from "react";

import type { FileTreeNode } from "#shared/contracts";

export const MAX_LOADED_DIRECTORIES = 50;
export const useLazyChildren = (
  identity: string,
  revision: number,
  options: (directory: string) => UseQueryOptions<FileTreeNode[]>
) => {
  const [loaded, setLoaded] = useState({
    identity,
    revision,
    paths: [] as string[],
  });
  const paths =
    loaded.identity === identity && loaded.revision === revision
      ? loaded.paths
      : [];
  const children = useQueries({
    queries: paths.map((directory) => {
      const query = options(directory);
      return {
        ...query,
        queryKey: [...query.queryKey!, revision],
        gcTime: 0,
      };
    }),
    combine: (results) => results.flatMap((result) => result.data ?? []),
  });
  return {
    children,
    load(directory: string) {
      setLoaded((previous) => {
        const paths =
          previous.identity === identity && previous.revision === revision
            ? previous.paths
            : [];
        return {
          identity,
          revision,
          paths: [
            ...paths.filter((path) => path !== directory),
            directory,
          ].slice(-MAX_LOADED_DIRECTORIES),
        };
      });
    },
  };
};
