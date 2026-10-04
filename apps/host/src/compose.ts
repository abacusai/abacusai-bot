export const composeNodeHost = async () => {
  const { HostLease } = await import("./lease");
  const { createNodeAppOperations } = await import("./app-operations");
  const { createNodeHostOperations, nodeHostPlatform } =
    await import("./host-operations");
  const { composeHost } = await import("#main/compose-host");
  const { ServiceHost } = await import("#main/service-host");
  const { CueArbiter } = await import("#main/notch/cue-arbiter");
  const { unsupported } = await import("./unsupported");
  const { trashItem } = await import("./filesystem");
  const serviceHost = new ServiceHost("web-host", { trashItem });
  const lease = new HostLease(
    () =>
      serviceHost.aguiRelay.busy ||
      serviceHost
        .listRoutineHistories()
        .some(({ id }) =>
          serviceHost
            .listRoutineRuns(id)
            .some((run) => run.outcome === "running")
        )
  );
  const appOps = createNodeAppOperations(lease, serviceHost);
  const composition = await composeHost({
    serviceHost,
    appOps,
    hostOps: createNodeHostOperations(serviceHost),
    hostPlatform: nodeHostPlatform,
    platform: "web-host",
    windows: {
      mainRendererId: () => null,
      contents: () => null,
      state: () => null,
      chrome: () => null,
      reportReady: () => {},
    },
    browserRuntime: {
      materialize: () => unsupported(),
      materializeFile: () => unsupported(),
      present: () => unsupported(),
      navigate: () => unsupported(),
      capture: () => unsupported(),
      hide: () => unsupported(),
      close: () => unsupported(),
      promoteScope: () => unsupported(),
    },
    update: {
      checkForUpdates: async () => unsupported("update.check"),
      installUpdate: async () => unsupported("update.install"),
      getStatus: () => ({
        checking: false,
        available: false,
        downloading: false,
        downloaded: false,
        installing: false,
        error: null,
        progress: null,
        updateInfo: null,
        installStalled: false,
        criticalUpdate: false,
        failedPhase: null,
      }),
    },
    cues: new CueArbiter({
      windows: {
        mainRendererId: () => null,
        mainFocused: () => false,
        audible: () => null,
        canPlay: () => false,
      },
      onWindowGone: (_id, forget) => forget(),
    }),
  });
  const stopOutput = composition.deps.bus.listen(
    (event) => event.type === "terminal-output",
    () => lease.terminalOutput()
  );
  return {
    ...composition,
    lease,
    appOps,
    dispose: async () => {
      stopOutput();
      await composition.dispose();
    },
  };
};
