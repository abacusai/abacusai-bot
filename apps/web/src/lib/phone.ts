/** A phone: touch first, and a screen whose shorter side is phone-sized. */
export const isPhone = (): boolean =>
  matchMedia("(pointer: coarse)").matches &&
  Math.min(screen.width, screen.height) < 600;
