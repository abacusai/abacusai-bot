import os from "os";

const LOW_END_MAX_MEMORY_BYTES = 8 * 1024 ** 3;
const LOW_END_MAX_CPUS = 4;

/**
 * 8 GB of memory or less, or 4 logical CPUs or fewer: where the app trades
 * background work for responsiveness.
 */
export const isLowEndMachine = (): boolean =>
  os.totalmem() <= LOW_END_MAX_MEMORY_BYTES ||
  os.cpus().length <= LOW_END_MAX_CPUS;
