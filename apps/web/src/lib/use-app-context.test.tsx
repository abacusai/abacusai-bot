/**
 * Non-row toggles (spec 09 D7): the value flips before the call answers, a
 * refusal restores the previous value and reports, and the key refetches.
 */
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

import { useOptimisticToggle } from "./use-app-context";

// useAppContext reads the router's context; the hook needs its queryClient.
const context = vi.hoisted(() => ({ queryClient: undefined as unknown }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ options: { context } }),
}));

const setup = (mutationFn: () => Promise<unknown>) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  context.queryClient = queryClient;
  let server = { search: false };
  const read = vi.fn(async () => server);
  const onError = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => ({
      query: useQuery({ queryKey: ["toolsets"], queryFn: read }),
      toggle: useOptimisticToggle({
        queryKey: ["toolsets"],
        mutationFn: async (enabled: boolean) => {
          await mutationFn();
          server = { search: enabled };
        },
        apply: (data: { search: boolean }, enabled) => ({
          ...data,
          search: enabled,
        }),
        onError,
      }),
    }),
    { wrapper }
  );
  return { result, read, onError, queryClient };
};

it("shows the new value before the call answers and keeps it once it succeeds", async () => {
  let answer!: () => void;
  const { result, read } = setup(
    () => new Promise<void>((resolve) => (answer = resolve))
  );
  await waitFor(() =>
    expect(result.current.query.data).toEqual({ search: false })
  );
  act(() => result.current.toggle.mutate(true));
  await waitFor(() =>
    expect(result.current.query.data).toEqual({ search: true })
  );
  const reads = read.mock.calls.length;
  await act(async () => answer());
  await waitFor(() => expect(read.mock.calls.length).toBe(reads + 1));
  expect(result.current.query.data).toEqual({ search: true });
});

it("puts the previous value back and reports when the call is refused", async () => {
  const { result, onError } = setup(() => Promise.reject(new Error("no")));
  await waitFor(() =>
    expect(result.current.query.data).toEqual({ search: false })
  );
  act(() => result.current.toggle.mutate(true));
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(result.current.query.data).toEqual({ search: false });
});
