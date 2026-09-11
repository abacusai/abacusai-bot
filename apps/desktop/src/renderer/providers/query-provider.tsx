import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type JSX, type ReactNode } from "react";

import { LOCAL_CODE_QUERY_STALE_TIMES } from "../lib/query-keys";

export const createQueryClient = (): QueryClient => {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: LOCAL_CODE_QUERY_STALE_TIMES.metadata,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
};

export const queryClient = createQueryClient();

export const QueryProvider = ({
  children,
}: {
  children: ReactNode;
}): JSX.Element => {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};
