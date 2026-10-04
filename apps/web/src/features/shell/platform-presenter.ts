import { Store } from "@tanstack/react-store";

import type { AppClient } from "#renderer/data/transport/types";
import { IS_ELECTRON } from "#renderer/lib/platform";

import type { NativePresenter } from "./native-presenter";
const factory = IS_ELECTRON
  ? (await import("./native-presenter")).nativePresenterFor
  : undefined;
const browserPresenter: NativePresenter = {
  captures: new Store<Record<string, string>>({}),
  owner: new Store<string | null>(null),
  refresh: async () => {},
  activate: async () => {},
  register: () => () => {},
};
export const nativePresenterFor = (client: AppClient): NativePresenter =>
  factory ? factory(client) : browserPresenter;
