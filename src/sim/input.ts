/** Driver controls, normalised. The only thing that drives the simulation. */
export interface DriverInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  /** 0..1 */
  handbrake: number;
}

export const NEUTRAL_INPUT: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

export const cloneInput = (i: DriverInput): DriverInput => ({ ...i });
