import { connectorById, type Connector } from "@abacus-ai/connectors/registry";
import type { ConnectorOutcome } from "@abacus-ai/contract/contracts";
import {
  isMessagingPlatformConnected,
  SHARED_BOT_PLATFORM_OF,
  type MessagingPlatformId,
  type MessagingSnapshot,
} from "@abacus-ai/contract/messaging";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { Store, useStore } from "@tanstack/react-store";

import { signInAbacus } from "#platform/sign-in";
import type { Db } from "#renderer/data/db";
import type { Transport } from "#renderer/data/transport";
import { ConnectAttempt } from "#renderer/lib/connect-page";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { connectTarget } from "#renderer/lib/platform-system";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";

/** How long a chat app's pairing may stay open before it is given up. */
export const PAIRING_WAIT_MS = 180_000;
export interface FlowDeps {
  transport: Transport;
  db: Db;
  queryClient: QueryClient;
  navigate(platform: MessagingPlatformId): Promise<void>;
  /** After a sign-in: the router context's credential refresh. */
  credentialsChanged?(): Promise<unknown>;
}
export type FlowState = {
  connectorId: string | null;
  /** `waiting`: the connect page or the host's route is open in another tab. */
  phase: "idle" | "waiting" | "fields" | "pairing" | "signing-in";
  error?: string;
};
export const connectPlatform = async (
  deps: Pick<FlowDeps, "transport" | "queryClient">,
  platformId: MessagingPlatformId
): Promise<MessagingSnapshot> => {
  let snapshot = await deps.transport.client.messaging.snapshot({});
  if (!snapshot.gatewayEnabled)
    snapshot = await deps.transport.client.messaging.updateSettings({
      gatewayEnabled: true,
    });
  snapshot = await deps.transport.client.messaging.updatePlatform({
    platformId,
    enabled: true,
  });
  deps.queryClient.setQueryData(
    deps.transport.orpc.messaging.snapshot.queryKey({ input: {} }),
    snapshot
  );
  return snapshot;
};
export const disablePlatform = async (
  deps: Pick<FlowDeps, "transport" | "queryClient">,
  platformId: MessagingPlatformId
) => {
  const shared = SHARED_BOT_PLATFORM_OF[platformId];
  if (shared)
    await deps.transport.client.messaging.updatePlatform({
      platformId: shared,
      enabled: false,
    });
  const snapshot = await deps.transport.client.messaging.updatePlatform({
    platformId,
    enabled: false,
  });
  deps.queryClient.setQueryData(
    deps.transport.orpc.messaging.snapshot.queryKey({ input: {} }),
    snapshot
  );
};
export const createConnectFlow = (deps: FlowDeps) => {
  const store = new Store<FlowState>({ connectorId: null, phase: "idle" });
  type PairingRecord = {
    id: number;
    connectorId: string;
    platform?: MessagingPlatformId;
    resolve(outcome: ConnectorOutcome): void;
    /** The pairing's watchdog. */
    timer?: ReturnType<typeof setTimeout>;
    /** The connect in flight; it owns its own deadline. */
    attempt?: ConnectAttempt;
    ready?: Promise<void>;
    settlement?: Promise<void>;
  };
  let active: PairingRecord | null = null;
  let serial = 0;
  const finishRecord = (a: PairingRecord, result: ConnectorOutcome) => {
    if (a.timer) clearTimeout(a.timer);
    a.attempt?.cancel();
    if (active?.id === a.id) {
      active = null;
      store.setState(() => ({
        connectorId: a.connectorId,
        phase: "idle",
        ...(!result.ok && !result.cancelled ? { error: result.error } : {}),
      }));
    }
    a.resolve(result);
  };
  const finish = (id: number, result: ConnectorOutcome) => {
    if (active?.id === id) finishRecord(active, result);
  };
  // Sessions are not refreshed here: main brings each one's tools to the
  // account's connectors at its next turn start.
  const refresh = async () => {
    await deps.queryClient.invalidateQueries({
      queryKey: deps.transport.orpc.connectors.statuses.queryKey({ input: {} }),
    });
  };
  const complete = async (
    id: number,
    entry: Connector,
    result: ConnectorOutcome
  ) => {
    if (active?.id !== id) return;
    if (result.ok) await refresh();
    if (active?.id !== id) return;
    finish(id, result);
  };
  const cancel = async () => {
    const a = active;
    if (!a) return;
    finish(a.id, { ok: false, cancelled: true, error: "cancelled" });
    if (a.platform) await disablePlatform(deps, a.platform);
  };
  const settleRecord = (a: PairingRecord): Promise<void> => {
    if (a.settlement) return a.settlement;
    if (a.timer) clearTimeout(a.timer);
    a.settlement = (async () => {
      try {
        await a.ready;
        const fresh = await deps.queryClient.fetchQuery({
          ...deps.transport.orpc.messaging.snapshot.queryOptions({ input: {} }),
          staleTime: 0,
        });
        const ok = isMessagingPlatformConnected(fresh, a.platform!);
        finishRecord(
          a,
          ok
            ? { ok: true }
            : { ok: false, cancelled: true, error: "not-linked" }
        );
        if (ok) await refresh();
        else await disablePlatform(deps, a.platform!);
      } catch (e) {
        finishRecord(a, { ok: false, error: errorText(e) });
        await disablePlatform(deps, a.platform!);
      }
    })();
    return a.settlement;
  };
  // Direct routes and catalogue flows share one settlement owner.
  const registerPairing = (
    platform: MessagingPlatformId,
    setup: () => Promise<void>
  ) => {
    if (active?.platform !== platform) {
      if (active?.platform) void settleRecord(active).catch(() => undefined);
      else if (active) void cancel().catch(() => undefined);
      const id = ++serial;
      active = {
        id,
        connectorId: platform,
        platform,
        resolve: () => {},
        timer: setTimeout(() => {
          if (active?.id !== id) return;
          void cancel().catch(() => undefined);
        }, PAIRING_WAIT_MS),
      };
      store.setState(() => ({ connectorId: platform, phase: "pairing" }));
    }
    const ready = setup();
    active.ready = ready;
    return ready;
  };
  const settlePairing = async (platform: MessagingPlatformId) => {
    const a = active;
    if (a?.platform !== platform) {
      const deferred =
        deps.db.collections.prefs.get("app")?.onboardingPairing ?? [];
      if (!deferred.some((id) => id === platform)) return;
      const fresh = await deps.queryClient.fetchQuery({
        ...deps.transport.orpc.messaging.snapshot.queryOptions({ input: {} }),
        staleTime: 0,
      });
      if (isMessagingPlatformConnected(fresh, platform))
        await deps.db.updatePrefs({
          onboardingPairing: deferred.filter((id) => id !== platform),
        });
      return;
    }
    await settleRecord(a);
  };
  /** A chat app: enabled now, then paired on its page or deferred to later. */
  const pair = async (
    id: number,
    entry: Extract<Connector, { kind: "messaging" }>,
    pairing: "navigate" | "defer" | undefined
  ) => {
    if (active) active.platform = entry.platform;
    await connectPlatform(deps, entry.platform);
    if (active?.id !== id) return;
    if (pairing === "defer") {
      const prefs = deps.db.collections.prefs.get("app");
      await deps.db.updatePrefs({
        onboardingPairing: [
          ...new Set([...(prefs?.onboardingPairing ?? []), entry.platform]),
        ],
      });
      finish(id, { ok: true });
      return;
    }
    store.setState(() => ({ connectorId: entry.id, phase: "pairing" }));
    await deps.navigate(entry.platform);
  };
  /** The attempt's tab opened in the click; the host is signed in first when it must be. */
  const attempt = (connectorId: string): ConnectAttempt =>
    new ConnectAttempt(deps.transport, connectorId, {
      signIn: async () => {
        const result = await signInAbacus(deps.transport, { intent: "signin" });
        if (result.ok) await deps.credentialsChanged?.();
        return result;
      },
      onPhase: (phase) =>
        store.setState((state) =>
          state.connectorId === connectorId ? { ...state, phase } : state
        ),
    });
  const start = async (
    connectorId: string,
    options: { pairing?: "navigate" | "defer" } = {}
  ): Promise<ConnectorOutcome> => {
    const entry = connectorById(connectorId);
    if (!entry) return { ok: false, error: "unknown-connector" };
    const target = connectTarget(connectorId);
    // Inside the click, before any await: a tab opens now or not at all.
    const connecting =
      target.kind === "pairing" || target.kind === "fields"
        ? null
        : attempt(connectorId);
    const id = ++serial;
    await cancel();
    if (id !== serial) {
      connecting?.cancel();
      return { ok: false, cancelled: true, error: "superseded" };
    }
    const outcome = new Promise<ConnectorOutcome>((resolve) => {
      active = {
        id,
        connectorId,
        resolve,
        ...(connecting ? { attempt: connecting } : {}),
        // A connect attempt keeps its own deadline; a pairing gets this one.
        ...(target.kind === "pairing"
          ? {
              timer: setTimeout(() => {
                if (active?.id !== id) return;
                void cancel().catch(() => undefined);
                store.setState(() => ({
                  connectorId,
                  phase: "idle",
                  error: "timeout",
                }));
              }, PAIRING_WAIT_MS),
            }
          : {}),
      };
    });
    void (async () => {
      try {
        if (target.kind === "pairing" && entry.kind === "messaging")
          await pair(id, entry, options.pairing);
        else if (target.kind === "fields")
          store.setState(() => ({ connectorId, phase: "fields" }));
        else if (connecting != null) {
          store.setState(() => ({ connectorId, phase: "waiting" }));
          await complete(id, entry, await connecting.result);
        }
      } catch (e) {
        finish(id, { ok: false, error: errorText(e) });
      }
    })();
    return outcome;
  };
  const submit = async (values: Record<string, string>) => {
    const a = active;
    if (!a) return;
    try {
      const result = await deps.transport.client.connectors.submitFields({
        connectorId: a.connectorId,
        values,
      });
      const entry = connectorById(a.connectorId);
      if (entry) await complete(a.id, entry, result);
    } catch (e) {
      finish(a.id, { ok: false, error: errorText(e) });
    }
  };
  return { store, start, cancel, submit, settlePairing, registerPairing };
};
type Flow = ReturnType<typeof createConnectFlow>;
let documentFlow: Flow | null = null;
const flows = new WeakMap<Transport, Flow>();
const flowFor = (deps: FlowDeps) => {
  let flow = flows.get(deps.transport);
  if (!flow) {
    flow = createConnectFlow(deps);
    flows.set(deps.transport, flow);
  }
  documentFlow = flow;
  return flow;
};

/** @public Shared phase-5 integration API. */
export const startConnect = (
  connectorId: string,
  options?: { pairing?: "navigate" | "defer" }
): Promise<ConnectorOutcome> =>
  documentFlow
    ? documentFlow.start(connectorId, options)
    : Promise.resolve({ ok: false, error: "flow-not-mounted" });
export const useConnectFlow = () => {
  const { transport, db, credentialsChanged } = useAppContext();
  const queryClient = useQueryClient();
  const navigate = useAppNavigate();
  const flow = flowFor({
    transport,
    db,
    queryClient,
    credentialsChanged,
    navigate: (platform) =>
      navigate({
        to: "/library/messaging",
        search: { platform },
        state: { messagingDialog: true },
        transition: "none",
      }),
  });

  const state = useStore(flow.store, (s) => s);
  return { ...flow, state };
};
