/**
 * `app://` serves an installed experience's renderer only; the baseline still
 * loads from the asar. The version rides the hostname split in half (a 64-hex
 * digest exceeds the label limit) so a staged renderer resolves beside the
 * active one during a swap.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

import type { ExperienceStore } from "./experience-store";

const scheme = "app";
const rendererHostPattern =
  /^bundle\.(?<first>[a-f\d]{32})\.(?<second>[a-f\d]{32})$/u;

export const rendererUrl = (version: string): URL => {
  if (!/^[a-f\d]{64}$/u.test(version)) {
    throw new TypeError("Experience version must be a SHA-256 digest");
  }

  return new URL(`app://bundle.${version.slice(0, 32)}.${version.slice(32)}/`);
};

const rendererVersion = (hostname: string): string | null => {
  const match = rendererHostPattern.exec(hostname);
  const first = match?.groups?.first;
  const second = match?.groups?.second;

  return first === undefined || second === undefined
    ? null
    : `${first}${second}`;
};

const serveRenderer = (
  request: Request,
  rendererDirectory: string
): Promise<Response> | Response => {
  const url = new URL(request.url);
  let pathname: string;

  try {
    // Decode before the containment check so encoded separators cannot escape.
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const root = path.resolve(rendererDirectory);
  const file = path.resolve(
    root,
    pathname === "/" ? "index.html" : `.${pathname}`
  );

  if (!file.startsWith(`${root}${path.sep}`)) {
    return new Response("Bad request", { status: 400 });
  }

  return net.fetch(pathToFileURL(file).href);
};

/** Must run before `app.whenReady()`. */
export const registerAppScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        codeCache: true,
        secure: true,
        standard: true,
        supportFetchAPI: true,
      },
      scheme,
    },
  ]);
};

/** Call after ready. Returns the teardown. */
export const handleAppScheme = (store: ExperienceStore): (() => void) => {
  protocol.handle(scheme, (request): Promise<Response> | Response => {
    const url = new URL(request.url);
    const version = rendererVersion(url.hostname);

    if (version === null) {
      return new Response("Not found", { status: 404 });
    }

    const rendererDirectory = store.rendererDirectoryFor(version);

    return rendererDirectory === undefined
      ? new Response("Not found", { status: 404 })
      : serveRenderer(request, rendererDirectory);
  });

  return () => {
    protocol.unhandle(scheme);
  };
};
