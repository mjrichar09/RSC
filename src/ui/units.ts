/**
 * Turning the simulation's units into the ones on the screen.
 *
 * The simulation is metric and stays metric — metres, metres per second,
 * newton-seconds — because that is what the physics is written in and what
 * every tool, trace and tuning number is calibrated against. Converting in
 * `sim/` would mean re-deriving `npm run sweep`, every damage threshold and
 * every medal time against a unit change that is purely cosmetic.
 *
 * So the conversion happens here, at the last possible moment, and every
 * display that shows a distance or a speed goes through one of these. One
 * place, for the reason `groundHeight` and `coolantTarget` are one place: two
 * screens that disagree about how long a stage is are worse than either.
 *
 * The choice of unit per quantity is the one a driver would expect rather than
 * a single conversion applied everywhere — miles for a stage, yards for a
 * corner that is coming up, feet for a climb. Half a mile to the next bend is
 * not a useful number, and neither is 880 yards of stage.
 */

const MPH_PER_MS = 2.236936;
const METRES_PER_MILE = 1609.344;
const YARDS_PER_METRE = 1.093613;
const FEET_PER_METRE = 3.280840;

/** Speed in m/s to miles per hour, as a whole number. */
export const mph = (metresPerSecond: number): number =>
  Math.abs(metresPerSecond) * MPH_PER_MS;

/** A stage length in metres to miles, to two places. */
export const miles = (metres: number): number => metres / METRES_PER_MILE;

/** A distance in metres to yards. Corners, gaps — anything you can see. */
export const yards = (metres: number): number => metres * YARDS_PER_METRE;

/** A height in metres to feet. Climb and descent. */
export const feet = (metres: number): number => metres * FEET_PER_METRE;

/**
 * A distance ahead, rounded the way a co-driver calls it.
 *
 * Coarser the further away it is, because the number is a cue rather than a
 * measurement: "250" and "247" mean the same thing to somebody arriving at it
 * in four seconds, and the second one changes every frame. Under twenty yards
 * there is no number worth saying at all — you are already there.
 */
export function callDistance(metres: number): string {
  const y = yards(metres);
  if (y <= 20) return 'now';
  if (y < 100) return `${Math.round(y / 10) * 10} yd`;
  return `${Math.round(y / 50) * 50} yd`;
}
