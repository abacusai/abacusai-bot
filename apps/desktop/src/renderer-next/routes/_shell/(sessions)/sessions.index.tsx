import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/(sessions)/sessions/")({
  beforeLoad: () => {
    throw redirect({ to: "/sessions/new", replace: true });
  },
});
