/** Driver controls, normalised. The only thing that drives the simulation. */
export interface DriverInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /**
   * -1 (left) .. 1 (right), from the driver's point of view.
   *
   * The simulation's own frame has the car's local +X on its *left* — that
   * falls out of a right-handed, Y-up world with the nose along +Z — so this is
   * negated exactly once, where the vehicle consumes it. Everything above the
   * simulation, the AI included, speaks the driver's language: right is right.
   */
  steer: number;
  /** 0..1 */
  handbrake: number;
}

export const NEUTRAL_INPUT: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

export const cloneInput = (i: DriverInput): DriverInput => ({ ...i });
