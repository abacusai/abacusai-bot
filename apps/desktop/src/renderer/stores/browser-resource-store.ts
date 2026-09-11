import {
  createStore,
  useSelector,
  type UseSelectorOptions,
} from "@tanstack/react-store";
import { useMemo } from "react";

import {
  conversationRefFromKey,
  type ConversationKey,
  type DraftConversationKey,
  type SessionConversationKey,
} from "./right-panel-store";

export type BrowserResourceId = string & {
  readonly __browserResourceId: unique symbol;
};

export type BrowserNavigationState = {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
};

export type BrowserResource = {
  id: BrowserResourceId;
  scope: ConversationKey;
  url: string | null;
  title: string;
  profileId: string | null;
  navigation: BrowserNavigationState;
};

export type BrowserResourceScopeState = {
  resourceIds: readonly BrowserResourceId[];
  resources: Readonly<Record<string, BrowserResource>>;
};

export type BrowserResourceState = {
  scopes: Readonly<Record<string, BrowserResourceScopeState>>;
};

export type CreateBrowserResourceInput = {
  url?: string | null;
  title?: string;
  profileId?: string | null;
};

export type BrowserResourcePatch = {
  url?: string | null;
  title?: string;
  profileId?: string | null;
  navigation?: Partial<BrowserNavigationState>;
};

const EMPTY_NAVIGATION: BrowserNavigationState = Object.freeze({
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
});

const EMPTY_SCOPE: BrowserResourceScopeState = Object.freeze({
  resourceIds: Object.freeze([]),
  resources: Object.freeze({}),
});

let fallbackResourceId = 0;

const generateBrowserResourceId = (): BrowserResourceId => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID() as BrowserResourceId;
  }
  fallbackResourceId += 1;
  return `browser-${Date.now().toString(36)}-${fallbackResourceId.toString(36)}` as BrowserResourceId;
};

const normalizeTitle = (
  title: string | undefined,
  url: string | null
): string => {
  const normalized = title?.trim();
  return normalized && normalized.length > 0 ? normalized : (url ?? "Browser");
};

const selectScope = (
  state: BrowserResourceState,
  scope: ConversationKey
): BrowserResourceScopeState => state.scopes[scope] ?? EMPTY_SCOPE;

const updateScope = (
  state: BrowserResourceState,
  scope: ConversationKey,
  update: (
    current: BrowserResourceScopeState
  ) => BrowserResourceScopeState | null
): BrowserResourceState => {
  const current = selectScope(state, scope);
  const next = update(current);
  if (next === current) return state;
  if (next == null || next.resourceIds.length === 0) {
    if (!(scope in state.scopes)) return state;
    const { [scope]: _removed, ...scopes } = state.scopes;
    return { scopes };
  }
  return { scopes: { ...state.scopes, [scope]: next } };
};

const resourceExists = (
  state: BrowserResourceState,
  id: BrowserResourceId
): boolean =>
  Object.values(state.scopes).some((scope) => id in scope.resources);

const nextUniqueResourceId = (
  state: BrowserResourceState
): BrowserResourceId => {
  let id = generateBrowserResourceId();
  while (resourceExists(state, id)) id = generateBrowserResourceId();
  return id;
};

const rekeyScope = (
  scope: BrowserResourceScopeState,
  key: ConversationKey
): BrowserResourceScopeState => ({
  resourceIds: scope.resourceIds,
  resources: Object.fromEntries(
    Object.entries(scope.resources).map(([id, resource]) => [
      id,
      { ...resource, scope: key },
    ])
  ),
});

const mergePromotedScope = (
  draft: BrowserResourceScopeState,
  session: BrowserResourceScopeState | undefined,
  key: SessionConversationKey
): BrowserResourceScopeState => {
  const rekeyedDraft = rekeyScope(draft, key);
  if (session == null) return rekeyedDraft;
  const draftIds = new Set(rekeyedDraft.resourceIds);
  const sessionOnlyIds = session.resourceIds.filter((id) => !draftIds.has(id));
  return {
    resourceIds: [...rekeyedDraft.resourceIds, ...sessionOnlyIds],
    resources: {
      ...rekeyScope(session, key).resources,
      ...rekeyedDraft.resources,
    },
  };
};

export const createBrowserResourceState = (): BrowserResourceState => ({
  scopes: {},
});

export const browserResourceStore = createStore(createBrowserResourceState());

const updateBrowserResource = (
  scope: ConversationKey,
  id: BrowserResourceId,
  patch: BrowserResourcePatch
): void => {
  browserResourceStore.setState((state) =>
    updateScope(state, scope, (current) => {
      const resource = current.resources[id];
      if (resource == null) return current;
      const nextUrl = patch.url === undefined ? resource.url : patch.url;
      const next: BrowserResource = {
        ...resource,
        ...(patch.url === undefined ? {} : { url: patch.url }),
        ...(patch.title === undefined
          ? {}
          : { title: normalizeTitle(patch.title, nextUrl) }),
        ...(patch.profileId === undefined
          ? {}
          : { profileId: patch.profileId }),
        ...(patch.navigation == null
          ? {}
          : {
              navigation: {
                ...resource.navigation,
                ...patch.navigation,
              },
            }),
      };
      if (
        next.url === resource.url &&
        next.title === resource.title &&
        next.profileId === resource.profileId &&
        next.navigation.canGoBack === resource.navigation.canGoBack &&
        next.navigation.canGoForward === resource.navigation.canGoForward &&
        next.navigation.isLoading === resource.navigation.isLoading
      ) {
        return current;
      }
      return {
        ...current,
        resources: { ...current.resources, [id]: next },
      };
    })
  );
};

export const browserResourceActions = {
  create: (
    scope: ConversationKey,
    input: CreateBrowserResourceInput = {}
  ): BrowserResourceId => {
    const state = browserResourceStore.get();
    const id = nextUniqueResourceId(state);
    const url = input.url ?? null;
    const resource: BrowserResource = {
      id,
      scope,
      url,
      title: normalizeTitle(input.title, url),
      profileId: input.profileId ?? null,
      navigation: EMPTY_NAVIGATION,
    };
    browserResourceStore.setState((currentState) =>
      updateScope(currentState, scope, (current) => ({
        resourceIds: [...current.resourceIds, id],
        resources: { ...current.resources, [id]: resource },
      }))
    );
    return id;
  },

  update: updateBrowserResource,

  /** Register a resource main created for the agent, under main's id. */
  adopt: (scope: ConversationKey, id: string, url: string | null): void => {
    const resourceId = id as BrowserResourceId;
    browserResourceStore.setState((state) =>
      updateScope(state, scope, (current) => {
        if (current.resources[resourceId] != null) {
          return {
            ...current,
            resources: {
              ...current.resources,
              [resourceId]: { ...current.resources[resourceId]!, url },
            },
          };
        }
        return {
          resourceIds: [...current.resourceIds, resourceId],
          resources: {
            ...current.resources,
            [resourceId]: {
              id: resourceId,
              scope,
              url,
              title: normalizeTitle(undefined, url),
              profileId: null,
              navigation: EMPTY_NAVIGATION,
            },
          },
        };
      })
    );
  },

  setLocation: (
    scope: ConversationKey,
    id: BrowserResourceId,
    url: string | null,
    title?: string
  ): void =>
    updateBrowserResource(scope, id, {
      url,
      ...(title === undefined ? {} : { title }),
    }),

  setTitle: (
    scope: ConversationKey,
    id: BrowserResourceId,
    title: string
  ): void => updateBrowserResource(scope, id, { title }),

  setProfile: (
    scope: ConversationKey,
    id: BrowserResourceId,
    profileId: string | null
  ): void => updateBrowserResource(scope, id, { profileId }),

  setNavigation: (
    scope: ConversationKey,
    id: BrowserResourceId,
    navigation: Partial<BrowserNavigationState>
  ): void => updateBrowserResource(scope, id, { navigation }),

  dispose: (scope: ConversationKey, id: BrowserResourceId): void => {
    browserResourceStore.setState((state) =>
      updateScope(state, scope, (current) => {
        if (!(id in current.resources)) return current;
        const { [id]: _disposed, ...resources } = current.resources;
        return {
          resourceIds: current.resourceIds.filter(
            (resourceId) => resourceId !== id
          ),
          resources,
        };
      })
    );
  },

  disposeScope: (scope: ConversationKey): void => {
    browserResourceStore.setState((state) => {
      if (!(scope in state.scopes)) return state;
      const { [scope]: _disposed, ...scopes } = state.scopes;
      return { scopes };
    });
  },

  promoteDraft: (
    from: DraftConversationKey,
    to: SessionConversationKey
  ): void => {
    const fromRef = conversationRefFromKey(from);
    const toRef = conversationRefFromKey(to);
    if (
      fromRef?.kind !== "draft" ||
      toRef?.kind !== "session" ||
      fromRef.workspaceId !== toRef.workspaceId
    ) {
      return;
    }
    browserResourceStore.setState((state) => {
      const draft = state.scopes[from];
      if (draft == null) return state;
      const { [from]: _draft, ...scopes } = state.scopes;
      return {
        scopes: {
          ...scopes,
          [to]: mergePromotedScope(draft, scopes[to], to),
        },
      };
    });
  },

  disposeWorkspace: (workspaceId: string): void => {
    browserResourceStore.setState((state) => {
      const scopes = Object.fromEntries(
        Object.entries(state.scopes).filter(([key]) => {
          const ref = conversationRefFromKey(key as ConversationKey);
          return ref?.workspaceId !== workspaceId;
        })
      );
      return Object.keys(scopes).length === Object.keys(state.scopes).length
        ? state
        : { scopes };
    });
  },
} as const;

export const selectBrowserResourceScope = (
  state: BrowserResourceState,
  scope: ConversationKey
): BrowserResourceScopeState => selectScope(state, scope);

export const selectBrowserResource = (
  state: BrowserResourceState,
  scope: ConversationKey,
  id: BrowserResourceId
): BrowserResource | null => selectScope(state, scope).resources[id] ?? null;

export const useBrowserResourceScopeSelector = <Selected>(
  scope: ConversationKey,
  selector: (state: BrowserResourceScopeState) => Selected,
  options?: UseSelectorOptions<Selected>
): Selected =>
  useSelector(
    browserResourceStore,
    (state) => selector(selectScope(state, scope)),
    options
  );

export const useBrowserResources = (
  scope: ConversationKey
): readonly BrowserResource[] => {
  const state = useBrowserResourceScopeSelector(scope, (current) => current);
  return useMemo(
    () =>
      state.resourceIds.flatMap((id) => {
        const resource = state.resources[id];
        return resource == null ? [] : [resource];
      }),
    [state]
  );
};

// React state survives conversation switches; native views are still attached
// one at a time by ElectronBrowserRuntime.
export const useBrowserResource = (
  scope: ConversationKey,
  id: BrowserResourceId
): BrowserResource | null =>
  useBrowserResourceScopeSelector(
    scope,
    (state) => state.resources[id] ?? null
  );
