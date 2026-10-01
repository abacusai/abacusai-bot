/** Process-local compatibility refusals; transient IO failures remain retryable. */
export class RefusedTargets {
  readonly #hashes = new Set<string>();
  has(hash: string): boolean {
    return this.#hashes.has(hash);
  }
  async verify<T>(hash: string, verify: () => Promise<T>): Promise<T> {
    try {
      return await verify();
    } catch (error) {
      if (
        error instanceof Error &&
        /foundation|protocol|provenance/i.test(error.message)
      )
        this.#hashes.add(hash);
      throw error;
    }
  }
}
