import {
  createBrowserHistory,
  createHashHistory,
} from "@tanstack/react-router";

import { IS_BROWSER } from "#renderer/lib/platform";

/** Browser URLs share Vite's mount path; file-backed desktop windows use hashes. */
export const rendererHistory = () => {
  if (!IS_BROWSER) return { history: createHashHistory(), basepath: "/" };
  return {
    history: createBrowserHistory(),
    basepath: import.meta.env.BASE_URL,
  };
};
