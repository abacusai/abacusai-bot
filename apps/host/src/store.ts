import Conf, { type Options } from "conf";

import { app } from "./electron-shim";
export default class Store<
  T extends Record<string, any> = Record<string, unknown>,
> extends Conf<T> {
  constructor(options: Options<T> & { name?: string } = {}) {
    const { name, ...rest } = options;
    super({
      configName: name ?? "config",
      cwd: app.getPath("userData"),
      ...rest,
    });
  }
}
