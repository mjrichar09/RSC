/**
 * The volume control.
 *
 * There was only a mute before — the M key, all or nothing, and on a phone with
 * no keyboard not even that. What is worth pinning here is not that a number is
 * stored but that the two controls survive each other: a player who turns the
 * sound down to a tenth, mutes, and unmutes must get a tenth back rather than
 * whatever the code had hard-coded, which is exactly how a setting quietly
 * stops existing.
 *
 * No `AudioContext` is involved. The gain node is only reachable in a browser,
 * and the arithmetic that decides what to send it is not.
 */

import { describe, expect, it } from 'vitest';
import { Mixer } from '../src/audio/mixer.js';
import { DEFAULT_SETTINGS, migrateProfile } from '../src/game/save.js';

describe('the volume', () => {
  it('scales between silence and full', () => {
    const mixer = new Mixer();
    mixer.setVolume(0);
    expect(mixer.level).toBe(0);
    mixer.setVolume(1);
    const loudest = mixer.level;
    expect(loudest).toBeGreaterThan(0);
    mixer.setVolume(0.5);
    expect(mixer.level).toBeCloseTo(loudest / 2, 5);
  });

  it('stays below full scale, so a crash has somewhere to go', () => {
    // The limiter after the master needs headroom; a game that arrives at unity
    // has nothing left for the loudest thing in it.
    const mixer = new Mixer();
    mixer.setVolume(1);
    expect(mixer.level).toBeLessThan(1);
  });

  it('comes back where it was after a mute', () => {
    const mixer = new Mixer();
    mixer.setVolume(0.1);
    const quiet = mixer.level;
    mixer.toggleMute();
    expect(mixer.level).toBe(0);
    expect(mixer.isMuted).toBe(true);
    mixer.toggleMute();
    expect(mixer.level).toBeCloseTo(quiet, 5);
  });

  it('unmutes when the slider is moved up', () => {
    // A player who has just dragged the slider up and heard nothing has been
    // given a puzzle rather than a control.
    const mixer = new Mixer();
    mixer.toggleMute();
    expect(mixer.isMuted).toBe(true);
    mixer.setVolume(0.7);
    expect(mixer.isMuted).toBe(false);
    expect(mixer.level).toBeGreaterThan(0);
  });

  it('stays silent when the slider is dragged to zero', () => {
    // Zero is not an unmute: dragging to the bottom means silence, and coming
    // out of it by raising the slider is the same gesture as any other.
    const mixer = new Mixer();
    mixer.setVolume(0);
    expect(mixer.level).toBe(0);
    expect(mixer.isMuted).toBe(false);
  });

  it('refuses values outside the slider', () => {
    const mixer = new Mixer();
    mixer.setVolume(4);
    expect(mixer.currentVolume).toBe(1);
    mixer.setVolume(-2);
    expect(mixer.currentVolume).toBe(0);
  });
});

describe('the saved setting', () => {
  it('has a default and survives a reload', () => {
    expect(DEFAULT_SETTINGS.volume).toBeGreaterThan(0);
    const profile = migrateProfile({ settings: { volume: 0.25 } });
    expect(profile.settings.volume).toBe(0.25);
  });

  it('gives an old profile the default rather than silence', () => {
    // Anyone who played before this existed has no `volume` in their save. The
    // wrong answer is 0, which is a game that has lost its sound on upgrade.
    const profile = migrateProfile({ settings: { vision: 0.6 } });
    expect(profile.settings.volume).toBe(DEFAULT_SETTINGS.volume);
  });

  it('clamps a corrupted one', () => {
    expect(migrateProfile({ settings: { volume: 99 } }).settings.volume).toBe(1);
    expect(migrateProfile({ settings: { volume: -1 } }).settings.volume).toBe(0);
  });
});
