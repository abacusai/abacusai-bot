import {
  CriticalUpdateDialog,
  useUpdatePillAction,
} from "#renderer/features/settings/updates";
import { useTopBarEndActions } from "#renderer/features/shell/top-bar-slots";
export const UpdateOwner = () => {
  useTopBarEndActions(useUpdatePillAction());
  return <CriticalUpdateDialog />;
};
