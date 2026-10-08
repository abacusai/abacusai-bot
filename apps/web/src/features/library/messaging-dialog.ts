import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
import { useLocation, useRouter, useSearch } from "@tanstack/react-router";

import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";

export const useMessagingDialog = () => {
  const { platform } = useSearch({
    from: "/_shell/(library)/library/messaging",
  });
  const location = useLocation();
  const router = useRouter();
  const navigate = useAppNavigate();
  return {
    platform,
    open: (platform: MessagingPlatformId) =>
      navigate({
        to: "/library/messaging",
        search: { platform },
        state: { messagingDialog: true },
        transition: "none",
      }),
    close: async () => {
      if (location.state.messagingDialog && router.history.canGoBack()) {
        router.history.back();
      } else {
        await navigate({
          to: "/library/messaging",
          search: { platform: undefined },
          replace: true,
          transition: "none",
        });
      }
    },
    finalFocus: () =>
      document.querySelector<HTMLElement>(
        `[data-messaging-channel="${platform}"]`
      ),
  };
};
