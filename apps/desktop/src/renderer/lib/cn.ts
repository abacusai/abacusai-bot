import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class values and resolve Tailwind conflicts, so callers
 * can layer overrides (`cn(base, props.className)`) without duplicate or
 * contradictory utilities winning by source order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
