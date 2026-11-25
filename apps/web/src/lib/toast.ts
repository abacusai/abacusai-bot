import { failureText } from "#renderer/lib/error-text";
import { toast } from "#renderer/ui/toast";
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
/** Toasts a failure in the app's words (`errorText`); a cancelled one shows nothing. */
export const showFailure = (error: unknown, fallback?: string): void => {
  const text = failureText(error, fallback);
  if (text != null) showError(text);
};
export const showInfo = (
  title: string,
  options?: {
    description?: string;
    action?: { label: string; onClick(): void };
    timeout?: number;
  }
): void => {
  toast.add({
    title,
    ...(options?.description != null
      ? { description: options.description }
      : {}),
    ...(options?.timeout != null ? { timeout: options.timeout } : {}),
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
