/**
 * Where the visit counter loads.
 *
 * Only on Vercel's own hosts, because that is the only place its script
 * exists: anywhere else it is a 404 on every page load.
 */

import { describe, expect, it } from 'vitest';
import { servedByVercel } from '../src/ui/analytics.js';

describe('the visit counter', () => {
  it('loads on the Vercel copy, production and preview', () => {
    expect(servedByVercel('rsc.vercel.app')).toBe(true);
    expect(servedByVercel('rsc-git-main-mjr-fx.vercel.app')).toBe(true);
  });

  it('stays off GitHub Pages and the dev server', () => {
    expect(servedByVercel('mjrichar09.github.io')).toBe(false);
    expect(servedByVercel('localhost')).toBe(false);
    expect(servedByVercel('127.0.0.1')).toBe(false);
  });

  it('is not fooled by a host that only contains the name', () => {
    expect(servedByVercel('vercel.app.example.com')).toBe(false);
    expect(servedByVercel('notvercel.app')).toBe(false);
  });
});
