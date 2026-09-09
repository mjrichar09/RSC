/**
 * Is the player typing into something?
 *
 * The game binds single letters to actions — R restarts, M mutes, N opens the
 * lobby, T the tuning panel, the digits pick a stage — on a listener attached
 * to the window. That is right for a game and wrong for a game with text
 * fields in it: typing a room code like `RMX-2XU` restarted the run, muted the
 * sound and jumped to a stage, all before the code was finished. Space and the
 * arrows were worse, because the handler calls `preventDefault` on them, so a
 * space could not be typed and the caret could not be moved.
 *
 * `document.activeElement` is the whole answer and belongs in one place: three
 * different listeners need it, and a guard that is right in two of them is a
 * guard that is wrong.
 */
export function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  // A checkbox or a range slider takes no text, and the keys that drive them
  // are not the keys the game wants — a player nudging the volume slider with
  // the arrows should not also be steering.
  const type = (el as HTMLInputElement).type;
  return type !== 'button' && type !== 'submit' && type !== 'reset';
}
