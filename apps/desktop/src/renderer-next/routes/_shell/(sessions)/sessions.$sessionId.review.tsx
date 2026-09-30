import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute(
  "/_shell/(sessions)/sessions/$sessionId/review"
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/sessions/$sessionId",
      params,
      search: { tab: "changes" },
      replace: true,
    });
  },
});
