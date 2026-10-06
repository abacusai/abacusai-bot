import type { QueryClient } from "@tanstack/react-query";

// AbacusAI Bot's own WhatsApp number is a browser feature; the desktop app links WhatsApp itself.
export const loadWhatsAppOffered = async (_queryClient: QueryClient) => false;
export const OnboardingWhatsApp = (_props: { onDone(): void }) => null;
export const WhatsAppLinkedBanner = () => null;
