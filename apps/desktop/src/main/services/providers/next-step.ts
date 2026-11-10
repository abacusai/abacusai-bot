/**
 * Whether the desktop asks what comes next after a result (contract
 * next-step.ts). The hosted computer answers chat apps only, so it stays off.
 * ABACUSAI_BOT_NEXT_STEP=on|off pins it for a test run.
 */
export const nextStepOn = (): boolean => {
  if (import.meta.env.ABACUS_WEB_HOST === true) return false;
  return process.env.ABACUSAI_BOT_NEXT_STEP !== "off";
};
