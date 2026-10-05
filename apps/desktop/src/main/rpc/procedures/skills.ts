import { impl } from "./impl";

export const skillsRouter = impl.skills.router({
  listInstalled: impl.skills.listInstalled.handler(({ input, context }) =>
    context.deps.serviceHost.skillsService.listInstalled(input ?? {})
  ),
  search: impl.skills.search.handler(({ input, context }) =>
    context.deps.serviceHost.skillsService.searchMarketplace(input)
  ),
  install: impl.skills.install.handler(({ input, context }) =>
    context.deps.serviceHost.skillsService.install(input)
  ),
  remove: impl.skills.remove.handler(({ input, context }) =>
    context.deps.serviceHost.skillsService.remove(input)
  ),
  openFile: impl.skills.openFile.handler(({ input, context }) =>
    context.deps.serviceHost.skillsService.openFile(input)
  ),
  importLocal: impl.skills.importLocal.handler(({ input, context }) =>
    context.deps.app.importLocalSkills(input)
  ),
});
