import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_bare/onboarding/")({
  beforeLoad: () => {
    throw redirect({
      to: "/onboarding/$step",
      params: { step: "welcome" },
      replace: true,
    });
  },
});
