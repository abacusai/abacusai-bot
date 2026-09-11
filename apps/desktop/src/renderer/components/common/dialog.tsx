import { CircleAlert, XIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, Spinner } from "../ui";
import {
  Dialog as DialogRoot,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface DialogButton {
  label: string;
  variant: "default" | "secondary" | "destructive";
  onClick: () => void | Promise<boolean | string>;
}

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  icon?: LucideIcon;
  headerIcon?: ReactNode;
  titleBeforeIcon?: boolean;
  iconColor?: string;
  title: string;
  description?: string;
  children?:
    | ReactNode
    | ((isProcessing: boolean, clearError: () => void) => ReactNode);
  buttons: DialogButton[];
  size?: "md" | "full";
  closeOnOutsideClick?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
  "data-id"?: string;
}

export const Dialog = ({
  isOpen,
  onClose,
  icon,
  headerIcon,
  titleBeforeIcon = false,
  iconColor = "text-primary",
  title,
  description,
  children,
  buttons,
  size = "md",
  closeOnOutsideClick = true,
  closeOnEscape = true,
  showCloseButton = false,
  "data-id": dataId,
}: DialogProps): React.JSX.Element => {
  const { t } = useTranslation();
  const Icon = icon;
  const [processingButtonIndex, setProcessingButtonIndex] = useState<
    number | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const isProcessing = processingButtonIndex !== null;

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setProcessingButtonIndex(null);
    }
  }, [isOpen]);

  const handleButtonClick = async (
    button: DialogButton,
    index: number
  ): Promise<void> => {
    setProcessingButtonIndex(index);
    setError(null);
    try {
      const outcome = await button.onClick();
      if (outcome === true) onClose();
      if (typeof outcome === "string") setError(outcome);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProcessingButtonIndex(null);
    }
  };

  return (
    <DialogRoot
      open={isOpen}
      disablePointerDismissal={!closeOnOutsideClick || isProcessing}
      onOpenChange={(open, details) => {
        if (open) return;
        if (
          isProcessing ||
          (!closeOnEscape && details.reason === "escape-key") ||
          (!closeOnOutsideClick && details.reason === "outside-press")
        ) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-id={dataId}
        className={
          size === "full"
            ? "flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-5xl"
            : "gap-0 p-0 sm:max-w-md"
        }
      >
        {showCloseButton && (
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon"
                disabled={isProcessing}
                aria-label={t("common.close")}
                data-id={dataId ? `${dataId}-btn-close` : undefined}
                className="absolute end-3 top-3 z-10"
              />
            }
          >
            <XIcon />
          </DialogClose>
        )}

        <DialogHeader className="items-center px-6 pt-7 pb-5 text-center">
          {titleBeforeIcon && (
            <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          )}
          {headerIcon ?? (Icon && <Icon className={iconColor} size={22} />)}
          {!titleBeforeIcon && (
            <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          )}
          {description && (
            <DialogDescription className="mt-1 text-sm">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>

        {children && (
          <div
            className={`px-6 pt-1 pb-6 ${size === "full" ? "min-h-0 flex-1 overflow-y-auto" : ""}`}
          >
            {typeof children === "function"
              ? children(isProcessing, () => setError(null))
              : children}
          </div>
        )}

        {error && (
          <div className="text-destructive flex items-center gap-2 px-6 pb-4 text-sm">
            <CircleAlert className="size-4" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter className="gap-3 px-4 pb-4 sm:px-6 sm:pb-6">
          {buttons.map((button, index) => (
            <Button
              key={`${button.variant}-${button.label}`}
              variant={button.variant}
              size="lg"
              onClick={() => void handleButtonClick(button, index)}
              disabled={isProcessing}
              data-id={dataId ? `${dataId}-btn-${button.variant}` : undefined}
              className="w-full sm:w-auto"
            >
              {processingButtonIndex === index && <Spinner />}
              {button.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
};
