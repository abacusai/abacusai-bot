import { WebMessagingPage as Page } from "#renderer/features/library/whatsapp-phone";
import { callApps } from "#renderer/features/shell/connect/services";

export const WebMessagingPage = () => <Page callApps={callApps} />;
