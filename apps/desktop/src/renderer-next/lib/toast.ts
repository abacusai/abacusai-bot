import { toast } from "#next/ui/toast";
export const showError = (
  title: string,
  options?: { action?: { label: string; onClick(): void } }
): void => {
  toast.add({
    title,
    type: "error",
    ...(options?.action
      ? {
          actionProps: {
            children: options.action.label,
            onClick: options.action.onClick,
          },
        }
      : {}),
  });
};
export const showInfo = (title: string): void => {
  toast.add({ title });
};
