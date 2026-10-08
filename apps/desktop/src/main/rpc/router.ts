import { accountRouter } from "./procedures/account";
import { agentRouter } from "./procedures/agent";
import { aiRouter } from "./procedures/ai";
import { authRouter } from "./procedures/auth";
import { botsRouter } from "./procedures/bots";
import { browserRouter } from "./procedures/browser";
import { connectorsRouter } from "./procedures/connectors";
import { dbRouter } from "./procedures/db";
import { devicesRouter } from "./procedures/devices";
import { filesRouter } from "./procedures/files";
import { gitRouter } from "./procedures/git";
import { impl } from "./procedures/impl";
import { linksRouter } from "./procedures/links";
import { localModelsRouter } from "./procedures/local-models";
import { mcpRouter } from "./procedures/mcp";
import { memoryRouter } from "./procedures/memory";
import { messagingRouter } from "./procedures/messaging";
import { modelsRouter } from "./procedures/models";
import { notchRouter } from "./procedures/notch";
import { referralsRouter } from "./procedures/referrals";
import { routinesRouter } from "./procedures/routines";
import { sessionsRouter } from "./procedures/sessions";
import { settingsRouter } from "./procedures/settings";
import { skillsRouter } from "./procedures/skills";
import { systemRouter } from "./procedures/system";
import { terminalRouter } from "./procedures/terminal";
import { updateRouter } from "./procedures/update";
import { voiceRouter } from "./procedures/voice";
import { windowRouter } from "./procedures/window";
import { workspacesRouter } from "./procedures/workspaces";

/**
 * The oRPC router: the contract implemented over `RpcDeps` (spec 00 A.4).
 * Every procedure reaches main through its context's deps, so this module and
 * everything it imports load without Electron.
 */
const routes: {
  workspaces: typeof workspacesRouter;
  git: typeof gitRouter;
  files: typeof filesRouter;
  sessions: typeof sessionsRouter;
  agent: typeof agentRouter;
  ai: typeof aiRouter;
  bots: typeof botsRouter;
  routines: typeof routinesRouter;
  notch: typeof notchRouter;
  settings: typeof settingsRouter;
  models: typeof modelsRouter;
  links: typeof linksRouter;
  localModels: typeof localModelsRouter;
  account: typeof accountRouter;
  auth: typeof authRouter;
  referrals: typeof referralsRouter;
  connectors: typeof connectorsRouter;
  mcp: typeof mcpRouter;
  browser: typeof browserRouter;
  terminal: typeof terminalRouter;
  memory: typeof memoryRouter;
  devices: typeof devicesRouter;
  voice: typeof voiceRouter;
  messaging: typeof messagingRouter;
  system: typeof systemRouter;
  window: typeof windowRouter;
  update: typeof updateRouter;
  skills: typeof skillsRouter;
  db: typeof dbRouter;
} = {
  workspaces: workspacesRouter,
  git: gitRouter,
  files: filesRouter,
  sessions: sessionsRouter,
  agent: agentRouter,
  ai: aiRouter,
  bots: botsRouter,
  routines: routinesRouter,
  notch: notchRouter,
  settings: settingsRouter,
  models: modelsRouter,
  localModels: localModelsRouter,
  links: linksRouter,
  account: accountRouter,
  auth: authRouter,
  referrals: referralsRouter,
  connectors: connectorsRouter,
  mcp: mcpRouter,
  browser: browserRouter,
  terminal: terminalRouter,
  memory: memoryRouter,
  devices: devicesRouter,
  voice: voiceRouter,
  messaging: messagingRouter,
  system: systemRouter,
  window: windowRouter,
  update: updateRouter,
  skills: skillsRouter,
  db: dbRouter,
};
export const createRouter = (): typeof routes => impl.router(routes);

export type AppRouter = ReturnType<typeof createRouter>;
