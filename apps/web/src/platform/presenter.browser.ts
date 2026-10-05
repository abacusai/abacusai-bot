import { Store } from "@tanstack/react-store";

import type { AppClient } from "#renderer/data/transport/types";
import type { NativePresenter } from "#renderer/features/shell/native-presenter";

const browserPresenter: NativePresenter = {
  captures: new Store<Record<string, string>>({}),
  owner: new Store<string | null>(null),
  refresh: async () => {},
  activate: async () => {},
  register: () => () => {},
};
export const nativePresenterFor = (_client: AppClient): NativePresenter =>
  browserPresenter;
