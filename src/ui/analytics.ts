/**
 * Counting visits, on the copy of the game that Vercel serves.
 *
 * The game is published twice: GitHub Pages at /RSC/, which gives its owner no
 * visitor numbers at all, and Vercel, whose Web Analytics does. Vercel's script
 * lives at `/_vercel/insights/script.js` on Vercel's own hosts and nowhere else,
 * so it is loaded only there — on GitHub Pages or `npm run dev` the path is a
 * 404, and a 404 on every load is noise in the console for nothing.
 *
 * What it sends is a page view: path, referrer, country, device and browser.
 * No cookies, no identifiers, nothing typed into the game. It counts people
 * arriving, not what they do once they are here — races, stages and modes
 * would be custom events, and those are a separate decision.
 *
 * The host test is `*.vercel.app`. A custom domain pointed at the Vercel
 * project would need adding here, or its visits are simply not counted.
 */

const SCRIPT = '/_vercel/insights/script.js';

/** Whether this page is being served by Vercel, where the script exists. */
export function servedByVercel(hostname: string): boolean {
  return hostname === 'vercel.app' || hostname.endsWith('.vercel.app');
}

/**
 * Load Vercel Web Analytics, if this is the Vercel copy.
 *
 * The queue is Vercel's documented plain-HTML setup: `window.va` collects
 * calls until the deferred script arrives and replays them.
 */
export function startAnalytics(): void {
  if (!servedByVercel(location.hostname)) return;
  const w = window as unknown as { va?: (...args: unknown[]) => void; vaq?: unknown[][] };
  w.va ??= (...args: unknown[]) => {
    (w.vaq ??= []).push(args);
  };
  const script = document.createElement('script');
  script.defer = true;
  script.src = SCRIPT;
  document.head.appendChild(script);
}
