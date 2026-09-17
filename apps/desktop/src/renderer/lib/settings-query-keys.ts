/** Shared cache scopes for settings data read by more than one route or menu. */
export const settingsQueryKeys = {
  all: ["settings"] as const,

  models: {
    all: ["settings", "models"] as const,
    providers: ["settings", "models", "providers"] as const,
    abacusCredential: ["settings", "models", "abacus-credential"] as const,
  },

  connectors: {
    all: ["settings", "connectors"] as const,
    /** Every registry connector's status, from main's one table. */
    statuses: ["settings", "connectors", "statuses"] as const,
  },

  mcp: {
    all: ["settings", "mcp"] as const,
    servers: (mode: string) => ["settings", "mcp", "servers", mode] as const,
  },

  skills: {
    all: ["settings", "skills"] as const,
    installed: (workspacePath: string | null) =>
      ["settings", "skills", "installed", workspacePath ?? "global"] as const,
    marketplace: (query: string) =>
      ["settings", "skills", "marketplace", query] as const,
  },

  jobs: {
    all: ["settings", "jobs"] as const,
    list: ["settings", "jobs", "list"] as const,
  },

  messaging: {
    all: ["settings", "messaging"] as const,
    snapshot: ["settings", "messaging", "snapshot"] as const,
    whatsAppQr: ["settings", "messaging", "whatsapp-qr"] as const,
  },

  browser: {
    all: ["settings", "browser"] as const,
    status: ["settings", "browser", "status"] as const,
  },

  memory: {
    all: ["settings", "memory"] as const,
    snapshot: ["settings", "memory", "snapshot"] as const,
    instructions: ["settings", "memory", "instructions"] as const,
    bots: ["settings", "memory", "bots"] as const,
  },

  sandbox: {
    all: ["settings", "sandbox"] as const,
    support: ["settings", "sandbox", "support"] as const,
    defaultMode: ["settings", "sandbox", "default-mode"] as const,
  },

  capabilities: {
    all: ["settings", "capabilities"] as const,
    toolsets: ["settings", "capabilities", "toolsets"] as const,
    xaiSearch: ["settings", "capabilities", "xai-search"] as const,
    execBackend: ["settings", "capabilities", "exec-backend"] as const,
    // Shared with the terminal panel's `+` menu, which picks from the same
    // roster and writes the same preference.
    terminalShell: ["settings", "capabilities", "terminal-shell"] as const,
  },

  devices: {
    all: ["settings", "devices"] as const,
    status: ["settings", "devices", "status"] as const,
  },

  notifications: {
    all: ["settings", "notifications"] as const,
    preferences: ["settings", "notifications", "preferences"] as const,
  },
} as const;
