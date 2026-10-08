export interface ModelSetupBinding {
  status: "loading" | "error" | "empty" | "ready";
  providers: Array<{
    id: string;
    label: string;
    connected: boolean;
    connect: boolean;
  }>;
  localAvailable: boolean;
  connect(provider: string): Promise<void>;
  save(provider: string, key: string): Promise<void>;
  retry(): Promise<void>;
  settings(provider?: string): void;
}
