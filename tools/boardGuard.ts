/**
 * Keep the harnesses off the live leaderboard.
 *
 * `uicheck` and `mobilecheck` drive real arcade races under a made-up name, and
 * the game posts every finish to the board at the broker's absolute address —
 * which the dev server's stub middleware can never see, because the request
 * never comes to the dev server. So the "stub" board was only ever answering
 * requests nobody made, and a `uicheck` run put "Checkbot 42.208" on the public
 * Quarry Run night board, where it sat as a real player's time.
 *
 * This intercepts every board path at the browser, whatever host it is aimed
 * at, and answers from a stub: reads get the given record, writes are counted
 * and never sent. Room traffic (`/r`) is left alone — the lobby checks use the
 * real broker on purpose, and a room is gone in a minute.
 */

import type { BrowserContext, Page } from '@playwright/test';

export interface BoardGuard {
  /** Finishes the game tried to post, which went nowhere. */
  writes: number;
}

export async function guardBoard(
  target: Page | BrowserContext,
  record?: { name: string; time: number; at: number },
): Promise<BoardGuard> {
  const guard: BoardGuard = { writes: 0 };
  const top = record ? [record] : [];
  await target.route(
    (url) => /^\/(b|bs|g)(\/|$)/.test(url.pathname) && !url.hostname.startsWith('localhost'),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') guard.writes++;
      const body = path.startsWith('/bs')
        ? { boards: {} }
        : path.startsWith('/g')
          ? { ghost: null, stored: false }
          : request.method() === 'GET'
            ? { top }
            : { rank: null, top };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    },
  );
  return guard;
}
