/**
 * Escaping text that came from somebody else.
 *
 * Every name on the leaderboard was typed by a stranger and arrives over the
 * network, and both the arcade list and the finish panel build their markup as
 * strings. One copy, shared, because the failure mode of the second copy is
 * that it is the one somebody forgets to call.
 */
export const escapeHtml = (raw: string): string =>
  raw.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
