/**
 * Runs `fn` once no menu, popover or dialog is open (up to ~1 s), after the
 * last one has handed the focus back to the button that opened it: a tab
 * picked from a list, or a command run from the command menu, comes on
 * screen while that list still holds the focus. Outside components: the
 * React Compiler skips a component whose closures update a captured counter.
 */
export const afterMenusClose = (fn: () => void, frames = 0): void => {
  requestAnimationFrame(() => {
    if (
      frames < 60 &&
      document.querySelector(
        '[data-slot="popover-content"], [role="menu"], [role="dialog"], [role="alertdialog"]'
      )
    )
      afterMenusClose(fn, frames + 1);
    else setTimeout(fn, 0);
  });
};
