interface ImportMetaEnv {
  readonly ABACUS_WEB_HOST?: boolean;
  readonly ABACUS_DEV_HARNESS: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
