import { Power, RotateCw, Trash2 } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import errorBackground from "../../assets/error-img-back2.webp";
import { durableStorage } from "../../lib/durable-storage";
import { Button } from "../ui";

// Every zustand `persist()` store name. Clearing them resets UI state without
// touching workspace or session metadata, which live in the main process.
const PERSISTED_STORE_KEYS = [
  "abacusai-bot-language",
  "abacusai-bot-code-folder",
  "abacusai-bot.promptSnippets",
  "local-code-ui-store",
];

interface ErrorFallbackProps {
  error: Error | null;
  onRetry: () => void;
  onReload: () => void;
  onResetLocalData: () => void;
  showReset: boolean;
}

const ErrorFallback = ({
  error,
  onRetry,
  onReload,
  onResetLocalData,
  showReset,
}: ErrorFallbackProps) => {
  const { t } = useTranslation();
  return (
    <div className="bg-background fixed inset-0 flex flex-col items-center justify-center">
      <div
        className={"absolute inset-[30px] opacity-20"}
        style={{
          backgroundImage: `url(${errorBackground})`,
          backgroundSize: "contain",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
      ></div>

      {/* Dark overlay for readability */}
      <div className="bg-background/40 absolute inset-0" />

      {/* Content - centered */}
      <div className="relative z-10 flex flex-col items-center px-8 pb-[10%] text-center">
        <p className="text-destructive mb-3 text-4xl font-bold">
          {t("error.ouch")}
        </p>

        {/* Title */}
        <h1 className="text-foreground mb-3 text-3xl font-bold">
          {t("error.somethingWrong")}
        </h1>

        {/* Subtitle */}
        <p className="text-foreground/90 max-w-md text-xl">
          {t("error.unexpected")}
        </p>

        {/* Recovery actions */}
        <div className="mt-6 mb-6 flex flex-wrap items-center justify-center gap-3">
          <Button
            size="lg"
            data-id="error-boundary-try-again"
            onClick={onRetry}
          >
            <RotateCw />
            {t("error.tryAgain")}
          </Button>

          <Button
            variant="secondary"
            size="lg"
            data-id="error-boundary-reload-app"
            onClick={onReload}
          >
            <Power />
            {t("error.reloadApp")}
          </Button>
        </div>

        {/* Escalation: shown after repeated identical crashes — the persisted
            UI state is the likely culprit, so offer to wipe it. */}
        {showReset && (
          <div className="mb-2 flex flex-col items-center gap-2">
            <p className="text-foreground/70 max-w-90 text-sm">
              {t("error.keepsCrashing")}
            </p>
            <Button
              variant="secondary"
              size="lg"
              data-id="error-boundary-reset-local-data"
              onClick={onResetLocalData}
              className="text-destructive"
            >
              <Trash2 />
              {t("error.resetLocalData")}
            </Button>
          </div>
        )}

        {/* Error details */}
        {error && (
          <p className="text-foreground/60 mt-1 max-w-90 text-sm break-words">
            {error.message}
          </p>
        )}
      </div>
    </div>
  );
};

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  showReset: boolean;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  // Instance fields survive retries (the boundary itself never unmounts; only
  // its children remount), so they can track consecutive identical crashes.
  private lastErrorMessage: string | null = null;
  private repeatCount = 0;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, showReset: false };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("Error caught by ErrorBoundary:", error, errorInfo);

    // Two identical crashes in a row point at corrupt persisted state, not a
    // transient fault: offer "Reset local data".
    const message = error?.message ?? String(error);
    if (message === this.lastErrorMessage) {
      this.repeatCount += 1;
    } else {
      this.lastErrorMessage = message;
      this.repeatCount = 1;
    }
    if (this.repeatCount >= 2) {
      this.setState({ showReset: true });
    }
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = (): void => {
    window.location.reload();
  };

  handleResetLocalData = (): void => {
    for (const key of PERSISTED_STORE_KEYS) {
      try {
        durableStorage.removeItem(key);
      } catch {
        /* best-effort — keep clearing the rest even if one throws */
      }
    }
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          onRetry={this.handleRetry}
          onReload={this.handleReload}
          onResetLocalData={this.handleResetLocalData}
          showReset={this.state.showReset}
        />
      );
    }
    return this.props.children;
  }
}
