/**
 * The one way the agent builds a pi resource loader. On a hosted account
 * without local tools nothing from disk runs: no extensions, and no settings
 * packages or npm command for pi's package manager to install or run.
 */
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { userConfigCodeAllowed } from "./hosted-local-tools.js";

type ResourceLoaderOptions = ConstructorParameters<
  typeof DefaultResourceLoader
>[0];

type PiSettings = ReturnType<SettingsManager["getGlobalSettings"]>;

const withoutDiskCode = (settings: PiSettings): PiSettings => {
  const { packages: _p, npmCommand: _n, extensions: _e, ...rest } = settings;
  return rest;
};

/** The same settings, minus anything that installs or loads code from disk. */
const settingsWithoutDiskCode = (settings: SettingsManager): SettingsManager =>
  new Proxy(settings, {
    get(target, property) {
      if (property === "getGlobalSettings" || property === "getProjectSettings")
        return () => withoutDiskCode(target[property]());
      if (property === "getNpmCommand") return () => undefined;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

export const createResourceLoader = (
  options: ResourceLoaderOptions,
  env: NodeJS.ProcessEnv = process.env
): DefaultResourceLoader =>
  userConfigCodeAllowed(env)
    ? new DefaultResourceLoader(options)
    : new DefaultResourceLoader({
        ...options,
        noExtensions: true,
        settingsManager: settingsWithoutDiskCode(
          options.settingsManager ??
            SettingsManager.create(options.cwd, options.agentDir)
        ),
      });
