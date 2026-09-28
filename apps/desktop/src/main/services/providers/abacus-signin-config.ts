/**
 * Which surface the Abacus.AI sign-in opens in: an app window or the system
 * browser. The server assigns the arm per install (the sign-in surface
 * experiment, bucketed on the device id), so the answer is fetched before the
 * app has a key. Anything short of a clean answer is the browser, the flow
 * every release before this one shipped.
 */
import { app } from "electron";

import { deviceId } from "../debug-sync/device-id";
import { abacusAppHost, abacusUserAgent } from "./abacus-host";

export type SignInVariant = "in_app" | "browser";

const CONFIG_PATH = "/api/v1/_getAbacusaibotSignInConfig";

// Sign-in is the front door: a slow config call must not hold it shut.
const CONFIG_TIMEOUT_MS = 3000;

/**
 * Developer override for exercising one arm against production. Powerless in
 * a released build, like the host override: the arm is the server's call.
 */
const overrideVariant = (): SignInVariant | null => {
  try {
    if (app.isPackaged) return null;
  } catch {
    // No `app` outside electron (tests): honor the override.
  }
  const raw = (process.env.ABACUSAI_BOT_SIGNIN_SURFACE ?? "").trim();

  return raw === "in_app" || raw === "browser" ? raw : null;
};

// One arm per launch; the server keeps it stable across launches.
let cached: SignInVariant | null = null;

export const resolveSignInVariant = async (): Promise<SignInVariant> => {
  const override = overrideVariant();
  if (override != null) return override;
  if (cached != null) return cached;

  try {
    const response = await fetch(new URL(CONFIG_PATH, abacusAppHost()), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": abacusUserAgent(),
      },
      body: JSON.stringify({ deviceId: deviceId() }),
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    });
    if (!response.ok) return "browser";

    const payload = (await response.json().catch(() => null)) as {
      success?: unknown;
      result?: { inAppSignIn?: unknown };
    } | null;
    if (payload?.success !== true) return "browser";

    cached = payload.result?.inAppSignIn === true ? "in_app" : "browser";
    return cached;
  } catch (error) {
    console.warn(
      `[abacus-auth] sign-in config unavailable: ${error instanceof Error ? error.name : "unknown"}`
    );
    return "browser";
  }
};

/** Tests only. */
export const resetSignInVariantCache = (): void => {
  cached = null;
};
