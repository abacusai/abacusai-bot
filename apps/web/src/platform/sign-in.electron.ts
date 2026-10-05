export const webSignIn: typeof import("#renderer/lib/browser/sign-in").webSignIn =
  async () => {
    throw new Error("Browser sign-in unavailable on Electron");
  };
