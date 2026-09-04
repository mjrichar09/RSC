/**
 * Noticing that the page is running an old build.
 *
 * The game is a static site, and the only file that can go stale is
 * `index.html`. Everything else is content-hashed, so a fresh document
 * guarantees fresh code — a filename nobody has requested cannot be served from
 * a cache. That halves the problem before it starts.
 *
 * What is left is the document, and it is not really a *caching* problem.
 * GitHub Pages sends `max-age=600`, so an HTTP cache corrects itself in ten
 * minutes. The case that actually bit somebody was a phone with the game open
 * in a background tab: coming back to it makes no request at all, so the tab
 * kept running the JavaScript it loaded hours earlier. No cache header can fix
 * that, because nothing is being cached — nothing is being asked for.
 *
 * So the page asks. It fetches its own document with `cache: 'no-store'`,
 * compares the assets that document loads with the ones it is itself running,
 * and says so if they differ.
 *
 * ### Why a plain reload is enough
 *
 * A reload — the button, `location.reload()`, or pull-to-refresh — always at
 * least revalidates the top-level document, ignoring its freshness lifetime. So
 * the new HTML arrives, and it names asset URLs this browser has never
 * requested, which therefore cannot come from a cache. No hard refresh, which
 * matters because a hard refresh on a phone means digging through Settings.
 *
 * (`location.reload(true)` is deprecated and ignored everywhere; there is no
 * stronger reload available to script, and none is needed.)
 */

/**
 * Vite's build output directory, which is where the hashed files live.
 *
 * *Only* those count, and that is the whole trick. Comparing every script and
 * stylesheet a document mentions looked simpler and was wrong the first time it
 * ran: the dev server injects its own client script and rewrites tags, so the
 * two sides never matched and the bar was up before anything had been deployed.
 * A false alarm is the worst thing this feature can do — the only action it
 * offers is a reload, and a reload that changes nothing teaches people to
 * ignore it.
 *
 * Restricting to build output also makes this immune to anything added at
 * runtime, by an extension or by the game itself.
 */
const BUILT = '/assets/';

/**
 * The hashed assets a document loads, as one comparable string.
 *
 * Scripts *and* stylesheets, because a change to either is a new build and the
 * CSS is hashed separately — a release that only moved a stylesheet would go
 * unnoticed if this looked at scripts alone.
 *
 * Sorted, so attribute order in the HTML cannot make two identical builds look
 * different. Raw attribute values rather than resolved URLs, so this can be
 * compared against the same thing read out of a live DOM.
 *
 * Empty in development, where nothing is hashed. That is the right answer
 * there, and the caller treats it as "no opinion" rather than as a difference.
 */
export function assetSignature(html: string): string {
  const found: string[] = [];
  const pattern = /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = match[1]!;
    if (url.includes(BUILT)) found.push(url);
  }
  return found.sort().join('|');
}

/** The same, read from the document this code is running in. */
export function currentSignature(doc: Document): string {
  const found: string[] = [];
  for (const el of doc.querySelectorAll('script[src], link[href]')) {
    const url = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
    if (url.includes(BUILT)) found.push(url);
  }
  return found.sort().join('|');
}

/** Milliseconds between checks while the page is on screen. */
const INTERVAL = 15 * 60_000;
/** Never check more often than this, however many times it is asked. */
const THROTTLE = 60_000;

export class UpdateWatch {
  private known = false;
  private lastCheck = 0;
  private timer: number | null = null;
  private readonly mine: string;

  constructor(private readonly doc: Document = document) {
    this.mine = currentSignature(doc);
  }

  /** True once a newer build has been seen. Never goes back to false. */
  get stale(): boolean {
    return this.known;
  }

  /**
   * Ask the server what the current build is.
   *
   * Silent about failure on purpose. Offline, a captive portal, a deploy
   * half-propagated — none of those are worth telling a player about, and all
   * of them resolve themselves by the next check. The only thing this is
   * allowed to do is notice good news.
   */
  async check(force = false): Promise<boolean> {
    if (this.known) return true;
    // Nothing hashed to compare against: a dev server, or a build laid out some
    // other way. Either way this has no opinion, and an opinion without
    // evidence is exactly the false alarm to avoid.
    if (!this.mine) return false;
    const now = Date.now();
    if (!force && now - this.lastCheck < THROTTLE) return false;
    this.lastCheck = now;

    try {
      // The document itself, without query or hash — `?join=` must not become
      // part of what is fetched. `no-store` so this can never be answered by
      // the very cache it exists to detect.
      const response = await fetch(this.doc.location.pathname, {
        cache: 'no-store',
        headers: { accept: 'text/html' },
      });
      if (!response.ok) return false;
      const theirs = assetSignature(await response.text());
      // An empty signature means the response was not a document this can read
      // — a login page, an error page dressed as a 200. Not evidence of
      // anything, and certainly not evidence of a new build.
      if (!theirs || theirs === this.mine) return false;
    } catch {
      return false;
    }

    // Latched, and there is no event: `main.ts` reads `stale` once a frame,
    // because the bar has to appear when a *race ends* as well as when the
    // update is first seen. One polled flag is simpler to get right than a
    // callback plus a second path that has to agree with it.
    this.known = true;
    return true;
  }

  /**
   * Watch from now on.
   *
   * On becoming visible above all, because that is the case this exists for: a
   * phone coming back to a tab that has been open for hours. The interval is
   * the belt to that braces, for a machine left running on one screen.
   */
  start(): void {
    this.doc.addEventListener('visibilitychange', this.onVisible);
    this.timer = window.setInterval(() => {
      if (!this.doc.hidden) void this.check();
    }, INTERVAL);
    void this.check(true);
  }

  stop(): void {
    this.doc.removeEventListener('visibilitychange', this.onVisible);
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private readonly onVisible = (): void => {
    if (!this.doc.hidden) void this.check();
  };
}

/**
 * A bar offering the reload, and nothing else.
 *
 * Never automatic. Reloading somebody out of the middle of a stage to give them
 * a newer build is worse than the build being old, so this asks and waits — and
 * `main.ts` keeps it off screen while a race is actually running.
 */
export class UpdateBanner {
  private readonly root: HTMLElement;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'update-bar';
    this.root.hidden = true;
    this.root.innerHTML = `
      <span>A newer version of the game is out.</span>
      <button data-act="reload">Reload</button>`;
    this.root.querySelector('[data-act="reload"]')?.addEventListener('click', () => {
      // Plain, because plain is enough: a reload revalidates the document, and
      // the document names hashed assets this browser has never asked for.
      location.reload();
    });
    parent.appendChild(this.root);
  }

  private shown = false;

  /**
   * Safe to set every frame: the DOM is only touched when it changes.
   *
   * Which is how `main.ts` drives it — the bar has to appear when a race ends
   * as well as when the update is first noticed, and one assignment per frame
   * is far simpler to get right than two event paths that have to agree.
   */
  set visible(value: boolean) {
    if (value === this.shown) return;
    this.shown = value;
    this.root.hidden = !value;
  }
}
