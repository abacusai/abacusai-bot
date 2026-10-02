export const loadFixtureRuntime = async () => {
  if (import.meta.env.VITE_NEXT_DB_FIXTURES === "1")
    return (await import("./fixtures/player")).fixtureRuntime;
  throw new Error("Chat fixtures require VITE_NEXT_DB_FIXTURES=1");
};
