import {
  connectorById,
  connectUi,
  type Connector,
  type ConnectorField,
} from "@abacus-ai/connectors/registry";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { Store, useStore } from "@tanstack/react-store";

import type { Db } from "#renderer/data/db";
import type { Transport } from "#renderer/data/transport";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
import type { ConnectorOutcome } from "#shared/contracts";
import {
  isMessagingPlatformConnected,
  SHARED_BOT_PLATFORM_OF,
  type MessagingPlatformId,
  type MessagingSnapshot,
} from "#shared/messaging";
export const CONNECT_WATCHDOG_MS = 180000;
export const fieldsFor = (entry: Connector): Record<string, ConnectorField> => {
  if (entry.kind === "credential") return entry.fields;
  if (entry.kind !== "mcp") return {};
  if (entry.fields) return entry.fields;
  if (entry.auth === "token")
    return { token: { label: entry.token?.label ?? "Token", secret: true } };
  if (entry.auth === "oauth-client")
    return {
      clientId: { label: "Client ID", secret: false },
      clientSecret: { label: "Client secret", secret: true },
    };
  return Object.fromEntries(
    (entry.env ?? []).map((key) => [key, { label: key, secret: true }])
  );
};
export interface FlowDeps {
  transport: Transport;
  db: Db;
  queryClient: QueryClient;
  navigate(platform: MessagingPlatformId): Promise<void>;
}
export type FlowState = {
  connectorId: string | null;
  phase: "idle" | "hop" | "fields" | "pairing" | "signing-in";
  error?: string;
  chromeMissing?: boolean;
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
    timer?: ReturnType<typeof setTimeout>;
    ready?: Promise<void>;
    settlement?: Promise<void>;
  };
  let active: PairingRecord | null = null;
  let serial = 0;
  const finishRecord = (a: PairingRecord, result: ConnectorOutcome) => {
    if (a.timer) clearTimeout(a.timer);
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
  const refresh = async () => {
    await Promise.allSettled(
      deps.db.collections.sessions.toArray
        .filter((s) => s.status === "running")
        .map((s) =>
          deps.transport.client.mcp.refresh({
            workspaceId: s.workspaceId,
            sessionId: s.id,
          })
        )
    );
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
    let chromeMissing = false;
    if (result.ok) {
      await refresh();
      if (entry.kind === "mcp" && entry.requires === "google-chrome")
        chromeMissing = await deps.transport.client.browser
          .hasGoogleChrome({})
          .then((present) => !present)
          .catch(() => false);
    }
    if (active?.id !== id) return;
    finish(id, result);
    if (chromeMissing)
      store.setState((state) => ({ ...state, chromeMissing: true }));
  };
  const cancel = async () => {
    const a = active;
    if (!a) return;
    finish(a.id, { ok: false, cancelled: true, error: "cancelled" });
    if (a.platform) await disablePlatform(deps, a.platform);
    else await deps.transport.client.connectors.cancelConnect({});
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
        }, CONNECT_WATCHDOG_MS),
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
  const start = async (
    connectorId: string,
    options: { pairing?: "navigate" | "defer" } = {}
  ): Promise<ConnectorOutcome> => {
    const id = ++serial;
    await cancel();
    if (id !== serial)
      return { ok: false, cancelled: true, error: "superseded" };
    const entry = connectorById(connectorId);
    if (!entry) return { ok: false, error: "unknown-connector" };
    const outcome = new Promise<ConnectorOutcome>((resolve) => {
      active = {
        id,
        connectorId,
        resolve,
        timer: setTimeout(() => {
          if (active?.id !== id) return;
          void cancel().catch(() => undefined);
          store.setState(() => ({
            connectorId,
            phase: "idle",
            error: "timeout",
          }));
        }, CONNECT_WATCHDOG_MS),
      };
    });
    const current = () => active?.id === id;
    void (async () => {
      try {
        if (entry.kind === "platform") {
          const statuses = await deps.transport.client.connectors.statuses({});
          if (!current()) return;
          if (statuses[connectorId]?.reason === "not-signed-in") {
            store.setState(() => ({ connectorId, phase: "signing-in" }));
            const result = await deps.transport.client.auth.abacus.start({
              intent: "signin",
            });
            if (!current()) return;
            if (!result.ok) {
              finish(id, result);
              return;
            }
          }
        }
        const ui = connectUi(entry);
        if (ui === "pairing" && entry.kind === "messaging") {
          if (active) active.platform = entry.platform;
          await connectPlatform(deps, entry.platform);
          if (!current()) return;
          if (options.pairing === "defer") {
            const prefs = deps.db.collections.prefs.get("app");
            await deps.db.updatePrefs({
              onboardingPairing: [
                ...new Set([
                  ...(prefs?.onboardingPairing ?? []),
                  entry.platform,
                ]),
              ],
            });
            finish(id, { ok: true });
            return;
          }
          store.setState(() => ({ connectorId, phase: "pairing" }));
          await deps.navigate(entry.platform);
          return;
        }
        if (ui === "fields") {
          store.setState(() => ({ connectorId, phase: "fields" }));
          return;
        }
        store.setState(() => ({ connectorId, phase: "hop" }));
        const result = await deps.transport.client.connectors.connect({
          connectorId,
        });
        if (!current()) return;
        await complete(id, entry, result);
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
  const { transport, db } = useAppContext();
  const queryClient = useQueryClient();
  const navigate = useAppNavigate();
  const flow = flowFor({
    transport,
    db,
    queryClient,
    navigate: (platform) =>
      navigate({
        to: "/library/messaging",
        search: { platform },
        transition: "none",
      }),
  });

  const state = useStore(flow.store, (s) => s);
  return { ...flow, state };
};
