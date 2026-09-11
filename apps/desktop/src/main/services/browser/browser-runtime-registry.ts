import {
  conversationKey as sharedConversationKey,
  conversationRefFromKey,
  draftConversationRef,
  sessionConversationRef,
  type ConversationKey,
} from "#shared/conversation-scope";

export type { ConversationKey } from "#shared/conversation-scope";

export type BrowserResourceId = string & {
  readonly __browserResourceId: unique symbol;
};

export type ConversationScope = {
  workspaceId: string;
  sessionId: string | null;
};

export type BrowserRuntimeGeneration = number & {
  readonly __browserRuntimeGeneration: unique symbol;
};

export type BrowserRuntimeLease = {
  readonly conversationKey: ConversationKey;
  readonly resourceId: BrowserResourceId;
  readonly generation: BrowserRuntimeGeneration;
};

export type BrowserRuntimePresentation = "hidden" | "presented";

export type NativeBrowserWebContents = {
  close: () => void;
};

export type NativeBrowserView = {
  readonly webContents: NativeBrowserWebContents;
};

export type BrowserNativeViewFactory<
  View extends NativeBrowserView,
  MaterializeOptions = void,
> = {
  create: (lease: BrowserRuntimeLease, options?: MaterializeOptions) => View;
};

export type BrowserNativeViewHost<
  View extends NativeBrowserView,
  PresentationOptions = void,
> = {
  present: (
    view: View,
    lease: BrowserRuntimeLease,
    options?: PresentationOptions
  ) => void;
  hide: (view: View, lease: BrowserRuntimeLease) => void;
  detach: (view: View, lease: BrowserRuntimeLease) => void;
};

export type BrowserRuntimeSnapshot = BrowserRuntimeLease & {
  presentation: BrowserRuntimePresentation;
};

type RuntimeRecord<View extends NativeBrowserView> = {
  lease: BrowserRuntimeLease;
  view: View;
  presentation: BrowserRuntimePresentation;
};

type ScopeRecord<View extends NativeBrowserView> = {
  scope: ConversationScope;
  runtimes: Map<BrowserResourceId, RuntimeRecord<View>>;
};

const assertNonEmpty = (value: string, label: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${label} cannot be empty`);
  return normalized;
};

export const conversationKey = ({
  workspaceId,
  sessionId,
}: ConversationScope): ConversationKey =>
  sharedConversationKey(
    sessionId == null
      ? draftConversationRef(workspaceId)
      : sessionConversationRef(workspaceId, sessionId)
  );

export const browserResourceId = (value: string): BrowserResourceId =>
  assertNonEmpty(value, "browserResourceId") as BrowserResourceId;

export const conversationScopeFromKey = (
  key: ConversationKey
): ConversationScope => {
  const ref = conversationRefFromKey(key);
  if (ref == null) throw new TypeError("Invalid conversation key");
  return {
    workspaceId: ref.workspaceId,
    sessionId: ref.kind === "session" ? ref.sessionId : null,
  };
};

export class StaleBrowserRuntimeError extends Error {
  constructor(readonly lease: BrowserRuntimeLease) {
    super(
      `Browser runtime ${lease.resourceId} generation ${lease.generation} is stale`
    );
    this.name = "StaleBrowserRuntimeError";
  }
}

export class BrowserRuntimeNotFoundError extends Error {
  constructor(readonly lease: BrowserRuntimeLease) {
    super(`Browser runtime ${lease.resourceId} does not exist`);
    this.name = "BrowserRuntimeNotFoundError";
  }
}

export class BrowserScopePromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserScopePromotionError";
  }
}

/**
 * Owns only WebContentsView instances created through its injected factory.
 * There is deliberately no dependency on Electron's global webContents list.
 */
export class BrowserRuntimeRegistry<
  View extends NativeBrowserView,
  MaterializeOptions = void,
  PresentationOptions = void,
> {
  private readonly scopes = new Map<ConversationKey, ScopeRecord<View>>();
  private readonly latestGenerations = new Map<
    string,
    BrowserRuntimeGeneration
  >();
  private generation = 0;

  constructor(
    private readonly factory: BrowserNativeViewFactory<
      View,
      MaterializeOptions
    >,
    private readonly host: BrowserNativeViewHost<View, PresentationOptions>
  ) {}

  materialize(
    conversationKey: ConversationKey,
    resourceId: BrowserResourceId,
    options?: MaterializeOptions
  ): BrowserRuntimeLease {
    const existing = this.scopes.get(conversationKey)?.runtimes.get(resourceId);
    if (existing != null) return existing.lease;

    const scope = conversationScopeFromKey(conversationKey);
    const lease: BrowserRuntimeLease = Object.freeze({
      conversationKey,
      resourceId,
      generation: this.nextGeneration(),
    });
    const view = this.factory.create(lease, options);
    const scopeRecord = this.scopes.get(conversationKey) ?? {
      scope,
      runtimes: new Map(),
    };
    scopeRecord.runtimes.set(resourceId, {
      lease,
      view,
      presentation: "hidden",
    });
    this.scopes.set(conversationKey, scopeRecord);
    this.latestGenerations.set(
      this.runtimeKey(conversationKey, resourceId),
      lease.generation
    );
    return lease;
  }

  present(lease: BrowserRuntimeLease, options?: PresentationOptions): void {
    const runtime = this.requireCurrent(lease);
    if (runtime.presentation === "presented" && options === undefined) return;
    this.host.present(runtime.view, runtime.lease, options);
    runtime.presentation = "presented";
  }

  hide(lease: BrowserRuntimeLease): void {
    const runtime = this.requireCurrent(lease);
    if (runtime.presentation === "hidden") return;
    this.host.hide(runtime.view, runtime.lease);
    runtime.presentation = "hidden";
  }

  close(lease: BrowserRuntimeLease): void {
    const runtime = this.requireCurrent(lease);
    this.removeRuntime(runtime);
    this.disposeRuntime(runtime);
  }

  snapshot(lease: BrowserRuntimeLease): BrowserRuntimeSnapshot {
    const runtime = this.requireCurrent(lease);
    return { ...runtime.lease, presentation: runtime.presentation };
  }

  nativeView(lease: BrowserRuntimeLease): View {
    return this.requireCurrent(lease).view;
  }

  promoteDraftScope(
    draftKey: ConversationKey,
    sessionKey: ConversationKey
  ): readonly BrowserRuntimeLease[] {
    const draftScope = conversationScopeFromKey(draftKey);
    const sessionScope = conversationScopeFromKey(sessionKey);
    if (draftScope.workspaceId !== sessionScope.workspaceId) {
      throw new BrowserScopePromotionError(
        "A browser scope cannot be promoted across workspaces"
      );
    }
    if (draftScope.sessionId !== null || sessionScope.sessionId === null) {
      throw new BrowserScopePromotionError(
        "Promotion requires a draft source and a session target"
      );
    }

    const source = this.scopes.get(draftKey);
    const target = this.scopes.get(sessionKey);
    if (source == null) {
      return target == null
        ? []
        : [...target.runtimes.values()].map(({ lease }) => lease);
    }

    if (target != null) {
      for (const resourceId of source.runtimes.keys()) {
        if (target.runtimes.has(resourceId)) {
          throw new BrowserScopePromotionError(
            `Browser resource ${resourceId} already exists in the session scope`
          );
        }
      }
    }

    const destination = target ?? {
      scope: sessionScope,
      runtimes: new Map<BrowserResourceId, RuntimeRecord<View>>(),
    };
    const promoted: BrowserRuntimeLease[] = [];
    for (const [resourceId, runtime] of source.runtimes) {
      const lease: BrowserRuntimeLease = Object.freeze({
        conversationKey: sessionKey,
        resourceId,
        generation: this.nextGeneration(),
      });
      runtime.lease = lease;
      destination.runtimes.set(resourceId, runtime);
      this.latestGenerations.set(
        this.runtimeKey(sessionKey, resourceId),
        lease.generation
      );
      promoted.push(lease);
    }
    this.scopes.delete(draftKey);
    this.scopes.set(sessionKey, destination);
    return promoted;
  }

  disposeScope(conversationKey: ConversationKey): void {
    const scope = this.scopes.get(conversationKey);
    if (scope == null) return;
    this.scopes.delete(conversationKey);
    this.disposeRuntimes([...scope.runtimes.values()]);
  }

  disposeWorkspace(workspaceId: string): void {
    const normalizedWorkspaceId = assertNonEmpty(workspaceId, "workspaceId");
    const runtimes: RuntimeRecord<View>[] = [];
    for (const [key, scope] of this.scopes) {
      if (scope.scope.workspaceId !== normalizedWorkspaceId) continue;
      this.scopes.delete(key);
      runtimes.push(...scope.runtimes.values());
    }
    this.disposeRuntimes(runtimes);
  }

  disposeAll(): void {
    const runtimes = [...this.scopes.values()].flatMap((scope) => [
      ...scope.runtimes.values(),
    ]);
    this.scopes.clear();
    this.disposeRuntimes(runtimes);
  }

  private nextGeneration(): BrowserRuntimeGeneration {
    this.generation += 1;
    return this.generation as BrowserRuntimeGeneration;
  }

  private runtimeKey(
    conversationKey: ConversationKey,
    resourceId: BrowserResourceId
  ): string {
    return JSON.stringify([conversationKey, resourceId]);
  }

  private requireCurrent(lease: BrowserRuntimeLease): RuntimeRecord<View> {
    const runtime = this.scopes
      .get(lease.conversationKey)
      ?.runtimes.get(lease.resourceId);
    if (runtime?.lease.generation === lease.generation) return runtime;

    const latest = this.latestGenerations.get(
      this.runtimeKey(lease.conversationKey, lease.resourceId)
    );
    if (latest != null && lease.generation <= latest) {
      throw new StaleBrowserRuntimeError(lease);
    }
    throw new BrowserRuntimeNotFoundError(lease);
  }

  private removeRuntime(runtime: RuntimeRecord<View>): void {
    const scope = this.scopes.get(runtime.lease.conversationKey);
    if (scope == null) return;
    scope.runtimes.delete(runtime.lease.resourceId);
    if (scope.runtimes.size === 0)
      this.scopes.delete(runtime.lease.conversationKey);
  }

  private disposeRuntime(runtime: RuntimeRecord<View>): void {
    const failures: unknown[] = [];
    for (const dispose of [
      () => this.host.hide(runtime.view, runtime.lease),
      () => this.host.detach(runtime.view, runtime.lease),
      () => runtime.view.webContents.close(),
    ]) {
      try {
        dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    runtime.presentation = "hidden";
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to dispose browser runtime");
    }
  }

  private disposeRuntimes(runtimes: readonly RuntimeRecord<View>[]): void {
    const failures: unknown[] = [];
    for (const runtime of runtimes) {
      try {
        this.disposeRuntime(runtime);
      } catch (error) {
        if (error instanceof AggregateError) failures.push(...error.errors);
        else failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to dispose browser runtimes");
    }
  }
}
