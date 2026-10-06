import type { QueryClient } from "@tanstack/react-query";

import {
  loadWhatsAppOffered as loadOffered,
  WhatsAppClaim as Claim,
  WhatsAppConnect,
  WhatsAppLinkedBanner as LinkedBanner,
} from "#renderer/features/onboarding/whatsapp";
import { callApps } from "#renderer/features/shell/connect/services";

export const loadWhatsAppOffered = (queryClient: QueryClient) =>
  loadOffered(queryClient, callApps);

export const OnboardingWhatsApp = ({ onDone }: { onDone(): void }) => (
  <WhatsAppConnect
    callApps={callApps}
    as="h1"
    onLinked={onDone}
    onSkip={onDone}
  />
);

export const WhatsAppLinkedBanner = () => <LinkedBanner callApps={callApps} />;

export const WhatsAppClaim = () => <Claim callApps={callApps} />;
