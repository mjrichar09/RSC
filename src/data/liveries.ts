/**
 * Paint.
 *
 * The car is on screen for the entire game and has been the same orange car
 * since the first commit. A livery is the cheapest identity a racing game can
 * hand a player, and this one costs three colours and a number.
 *
 * Each is a *set* rather than a palette to mix: body, the dark trim that reads
 * as glass and bumpers, and the accent that the nose wears. That last one is
 * load-bearing — the bright nose is how the car's heading reads while it is
 * sideways in a cloud of gravel — so every livery here has an accent that is
 * clearly lighter and more saturated than its body, and none of them puts a
 * second bright colour at the back.
 */

export interface Livery {
  id: string;
  name: string;
  /** Main bodywork. */
  body: number;
  /** Glass, bumpers, mirrors and the cabin. */
  trim: number;
  /** The nose. Must read instantly against the body. */
  accent: number;
  /** Number and roof-decal colours. */
  number: number;
  numberBack: number;
}

export const LIVERIES: Livery[] = [
  {
    id: 'works-orange',
    name: 'Works Orange',
    body: 0xe8552f,
    trim: 0x1f242c,
    accent: 0xf2c14e,
    number: 0x14181d,
    numberBack: 0xf2ede2,
  },
  {
    id: 'martini',
    name: 'Winter White',
    body: 0xeceef1,
    trim: 0x1b2733,
    accent: 0x2f6fd0,
    number: 0x14181d,
    numberBack: 0xf2c14e,
  },
  {
    id: 'forest-green',
    name: 'Forest Green',
    body: 0x1f5c3a,
    trim: 0x14181d,
    accent: 0xd8c46a,
    number: 0xf2ede2,
    numberBack: 0x14322a,
  },
  {
    id: 'rally-blue',
    name: 'Rally Blue',
    body: 0x1f4f9c,
    trim: 0x161b22,
    accent: 0xf0f2f5,
    number: 0x14181d,
    numberBack: 0xf2ede2,
  },
  {
    id: 'ember',
    name: 'Ember',
    body: 0x8c1f22,
    trim: 0x191b1f,
    accent: 0xf29b3c,
    number: 0xf2ede2,
    numberBack: 0x2a1113,
  },
  {
    id: 'gravel-grey',
    name: 'Gravel Grey',
    body: 0x5b6068,
    trim: 0x14181d,
    accent: 0xc9f24e,
    number: 0x14181d,
    numberBack: 0xd8dde4,
  },
];

export const DEFAULT_LIVERY = LIVERIES[0]!;

export const liveryById = (id: string | undefined): Livery =>
  LIVERIES.find((livery) => livery.id === id) ?? DEFAULT_LIVERY;
