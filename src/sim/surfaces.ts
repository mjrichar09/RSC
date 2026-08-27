/**
 * Surface definitions. Grip coefficients multiply tire force; the remaining
 * fields drive drag, particle spray and audio in later phases.
 */

export type SurfaceId = 'tarmac' | 'gravel' | 'dirt' | 'mud' | 'snow' | 'ice' | 'grass';

export interface Surface {
  readonly id: SurfaceId;
  /** Multiplier on peak tire force. Tarmac is the 1.0 reference. */
  readonly grip: number;
  /** Rolling resistance coefficient — soft surfaces bleed speed. */
  readonly rollingResistance: number;
  /** How much loose material the tires throw. Drives particles in P6. */
  readonly spray: number;
  /**
   * How fast this surface wears a sliding tyre, relative to tarmac.
   *
   * Gravel is the worst of both worlds: not enough grip to stop you sliding,
   * abrasive enough to punish it. Snow and ice barely wear a tyre at all.
   */
  readonly abrasion: number;
  /** Debug/placeholder colour for the flat-shaded look. */
  readonly color: number;
}

export const SURFACES: Record<SurfaceId, Surface> = {
  tarmac: { id: 'tarmac', grip: 1.0, rollingResistance: 0.014, spray: 0.0, abrasion: 1.0, color: 0x3b3f46 },
  gravel: { id: 'gravel', grip: 0.72, rollingResistance: 0.035, spray: 1.0, abrasion: 1.35, color: 0x8a7a5e },
  dirt: { id: 'dirt', grip: 0.66, rollingResistance: 0.042, spray: 0.9, abrasion: 0.9, color: 0x6b543a },
  mud: { id: 'mud', grip: 0.55, rollingResistance: 0.075, spray: 1.2, abrasion: 0.45, color: 0x4a3b28 },
  snow: { id: 'snow', grip: 0.45, rollingResistance: 0.055, spray: 1.1, abrasion: 0.2, color: 0xd6dde4 },
  ice: { id: 'ice', grip: 0.35, rollingResistance: 0.012, spray: 0.1, abrasion: 0.1, color: 0xbcd4dd },
  grass: { id: 'grass', grip: 0.6, rollingResistance: 0.06, spray: 0.7, abrasion: 0.55, color: 0x4f6b3a },
};

export const surface = (id: SurfaceId): Surface => SURFACES[id];
