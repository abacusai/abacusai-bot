import { bootstrapRepositoryFromKeys } from "./repository.ts";

/**
 * CI-only: write a repository's version-1 metadata from existing keys (see
 * bootstrapRepositoryFromKeys). Used by the publish workflow when the
 * production prefix is empty.
 */
await bootstrapRepositoryFromKeys();
console.log("Bootstrapped version-1 repository metadata");
