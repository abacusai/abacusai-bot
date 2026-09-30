import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_shell/(bots)/bots/$botId/details")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/bots/$botId",
      params,
      search: { ...search, tab: "details" },
      replace: true,
    });
  },
});
