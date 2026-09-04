/**
 * Noticing an old build.
 *
 * The game is a static site whose assets are content-hashed, so the only file
 * that can go stale is `index.html` — and the case that actually caught
 * somebody was not an HTTP cache at all. It was a phone with the game open in a
 * background tab: returning to it makes no request, so it kept running the code
 * it loaded hours before. Nothing a server says can fix that, so the page asks.
 *
 * What is worth testing is the comparison and the restraint around it. A check
 * that cries wolf is worse than no check, because the only thing it can offer
 * is a reload — so most of this file is about the cases where it must stay
 * quiet.
 */

import { describe, expect, it, vi } from 'vitest';
import { UpdateWatch, assetSignature, currentSignature } from '../src/ui/update.js';

const built = (hash: string) => `
  <!doctype html><html><head>
    <link rel="icon" href="data:image/svg+xml,%3Csvg%3E" />
    <link rel="stylesheet" href="/RSC/assets/index-${hash}.css" />
    <script type="module" crossorigin src="/RSC/assets/index-${hash}.js"></script>
  </head><body><div id="app"></div></body></html>`;

/** A `Document` with just enough of one to be read. */
function fakeDoc(html: string, pathname = '/RSC/') {
  const urls: string[] = [];
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) urls.push(m[1]!);
  return {
    hidden: false,
    location: { pathname },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () =>
      urls.map((url) => ({
        getAttribute: (a: string) => (a === 'src' || a === 'href' ? url : null),
      })),
  } as unknown as Document;
}

describe('the build signature', () => {
  it('changes when any hashed asset changes', () => {
    expect(assetSignature(built('AAA'))).not.toBe(assetSignature(built('BBB')));
  });

  it('is the same for the same build', () => {
    expect(assetSignature(built('AAA'))).toBe(assetSignature(built('AAA')));
  });

  it('notices a stylesheet-only release', () => {
    // The CSS is hashed separately, so a release that only moved a stylesheet
    // would go unseen if this looked at scripts alone.
    const a = built('AAA');
    const b = a.replace('index-AAA.css', 'index-CCC.css');
    expect(assetSignature(a)).not.toBe(assetSignature(b));
  });

  it('ignores the inline favicon', () => {
    // A data URI is not served as a file and cannot go stale; letting it into
    // the signature would be noise, and the favicon here is a whole inline SVG.
    expect(assetSignature(built('AAA'))).not.toContain('data:');
  });

  it('does not depend on the order the tags appear in', () => {
    const swapped = `
      <script type="module" crossorigin src="/RSC/assets/index-AAA.js"></script>
      <link rel="stylesheet" href="/RSC/assets/index-AAA.css" />`;
    expect(assetSignature(swapped)).toBe(assetSignature(built('AAA')));
  });

  it('reads the same answer out of a live document', () => {
    // The two sides of the comparison have to agree exactly, or every check is
    // a false alarm: raw attribute values on both sides, never resolved URLs.
    const html = built('AAA');
    expect(currentSignature(fakeDoc(html))).toBe(assetSignature(html));
  });

  it('has no opinion in development, where nothing is hashed', () => {
    // Vite's dev server injects its own client script and rewrites tags, so the
    // served HTML and the live DOM genuinely differ there. Comparing everything
    // put the bar on screen before anything had been deployed — a false alarm,
    // which is the worst thing this can do, because the only action it offers
    // is a reload and a reload that changes nothing teaches people to ignore
    // it. Only hashed build output counts, and in dev there is none.
    const served = `<link rel="stylesheet" href="/src/ui/style.css" />
      <script type="module" src="/src/main.ts"></script>`;
    const live = `<script type="module" src="/@vite/client"></script>
      <link rel="stylesheet" href="/src/ui/style.css" />
      <script type="module" src="/src/main.ts"></script>`;
    expect(assetSignature(served)).toBe('');
    expect(currentSignature(fakeDoc(live))).toBe('');
  });

  it('is not confused by a script added at runtime', () => {
    // An extension, or the game itself. Anything outside the build output is
    // not evidence about which build this is.
    const html = built('AAA');
    const withExtra = `${html}<script src="https://example.test/thing.js"></script>`;
    expect(currentSignature(fakeDoc(withExtra))).toBe(assetSignature(html));
  });
});

describe('the watch', () => {
  const withFetch = (impl: () => Promise<Response>) => vi.stubGlobal('fetch', vi.fn(impl));

  it('says nothing when the build has not moved', async () => {
    withFetch(async () => new Response(built('AAA'), { status: 200 }));
    const watch = new UpdateWatch(fakeDoc(built('AAA')));
    expect(await watch.check(true)).toBe(false);
    expect(watch.stale).toBe(false);
  });

  it('notices when it has', async () => {
    withFetch(async () => new Response(built('BBB'), { status: 200 }));
    const watch = new UpdateWatch(fakeDoc(built('AAA')));
    expect(await watch.check(true)).toBe(true);
    expect(watch.stale).toBe(true);
  });

  it('stays quiet when the network does not answer', async () => {
    // Offline, a captive portal, a deploy half-propagated. None of those are a
    // new build, and none are worth telling a player about — they all resolve
    // themselves by the next check.
    withFetch(async () => {
      throw new Error('offline');
    });
    const watch = new UpdateWatch(fakeDoc(built('AAA')));
    expect(await watch.check(true)).toBe(false);
    expect(watch.stale).toBe(false);
  });

  it('ignores a response that is not the game', async () => {
    // A hotel portal answering 200 with its own page has no assets this can
    // read. An empty signature is not evidence of a new build.
    withFetch(async () => new Response('<html><body>Sign in</body></html>', { status: 200 }));
    expect(await new UpdateWatch(fakeDoc(built('AAA'))).check(true)).toBe(false);
  });

  it('ignores an error page', async () => {
    withFetch(async () => new Response(built('BBB'), { status: 503 }));
    expect(await new UpdateWatch(fakeDoc(built('AAA'))).check(true)).toBe(false);
  });

  it('fetches the document without the query string', async () => {
    // A lobby link carries `?join=` or `?room=`, and fetching those back would
    // be asking the server about a URL nobody serves.
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url);
        return new Response(built('AAA'), { status: 200 });
      }),
    );
    await new UpdateWatch(fakeDoc(built('AAA'), '/RSC/')).check(true);
    expect(asked).toEqual(['/RSC/']);
  });

  it('throttles, but never the check that matters', async () => {
    const spy = vi.fn(async () => new Response(built('AAA'), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const watch = new UpdateWatch(fakeDoc(built('AAA')));
    await watch.check(true);
    await watch.check();
    await watch.check();
    expect(spy).toHaveBeenCalledTimes(1);
    // Opening the lobby forces one, because that is where a stale build stops
    // being cosmetic and starts producing a confusing error.
    await watch.check(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stops asking once it knows', async () => {
    const spy = vi.fn(async () => new Response(built('BBB'), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const watch = new UpdateWatch(fakeDoc(built('AAA')));
    expect(await watch.check(true)).toBe(true);
    expect(await watch.check(true)).toBe(true);
    // The answer cannot change back, so there is nothing left to ask.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
