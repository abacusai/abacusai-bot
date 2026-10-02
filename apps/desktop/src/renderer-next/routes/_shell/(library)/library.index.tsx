import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/(library)/library/")({
  beforeLoad: () => {
    throw redirect({ to: "/library/connectors", replace: true });
  },
});
