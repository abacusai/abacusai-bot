export interface ModelSetupBinding {
  status: "loading" | "error" | "empty" | "ready";
  providers: Array<{
    id: string;
    label: string;
    connected: boolean;
    connect: boolean;
  }>;
  /** Signs the provider in; false when the sign-in was cancelled. */
  connect(provider: string): Promise<boolean>;
  /** Stops a sign-in `connect` is waiting on. */
  cancelConnect(provider: string): void;
  save(provider: string, key: string): Promise<void>;
  retry(): Promise<void>;
  settings(provider?: string): void;
}
