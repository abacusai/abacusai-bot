/**
 * Names of files that hold keys or tokens: the gate refuses to read them, and
 * nothing that leaves the machine carries them. A leaf entry, so the app's
 * main process can read it without the agent bundle.
 */

/**
 * Files that hold keys or tokens wherever they sit, matched on any segment
 * of the path. Templates (`.env.example`) are not secrets.
 */
export const SECRET_FILE_NAMES: readonly RegExp[] = [
  /^\.env(?!\.(?:example|sample|template|dist)$)(?:\..+)?$/i,
  /^\.envrc$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|asc|der)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i,
  /^\.(?:netrc|npmrc|pypirc|pgpass|git-credentials|htpasswd)$/i,
  /^\.(?:ssh|gnupg|aws|azure|kube|docker|password-store)$/i,
  /^(?:credentials|secrets?)(?:\.(?:json|ya?ml|toml|ini|txt))?$/i,
  /^(?:service[-_]?account|client[-_]?secret)[^/\\]*\.json$/i,
];

/** A file or folder name that holds keys or tokens (SECRET_FILE_NAMES). */
export const isSecretFileName = (name: string): boolean =>
  SECRET_FILE_NAMES.some((pattern) => pattern.test(name));
