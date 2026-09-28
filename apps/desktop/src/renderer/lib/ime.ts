/**
 * True while an IME is composing (Japanese, Chinese, Korean input). The Enter
 * that confirms a conversion arrives as a normal keydown; acting on it sends
 * half-typed text. Chromium flags it with isComposing, and keyCode 229 covers
 * the keydown that starts a composition.
 */
export const isImeComposing = (event: {
  nativeEvent: KeyboardEvent;
}): boolean =>
  event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
