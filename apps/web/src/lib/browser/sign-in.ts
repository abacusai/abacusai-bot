import type { AbacusAuthOutcome } from "@abacus-ai/contract/contracts";
import * as v from "valibot";

import type { Transport } from "#renderer/data/transport";
import { callApps } from "#renderer/features/shell/connect/services";
export const webSignIn = async (
  transport: Transport
): Promise<AbacusAuthOutcome> => {
  const { challenge } = await transport.client.auth.web.start({});
  const response = v.parse(
    v.object({ authCode: v.pipe(v.string(), v.minLength(1)) }),
    await callApps("createAbacusaibotAuthCode", { challenge })
  );
  await transport.client.auth.web.complete({ code: response.authCode });
  return { ok: true };
};
