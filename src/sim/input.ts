/** Driver controls, normalised. The only thing that drives the simulation. */
export interface DriverInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /**
   * Held on the line by the start lights. All four wheels are braked and the
   * gearbox never selects reverse, while the throttle still reaches the engine
   * so there is a launch to time. The rear handbrake alone used to do this, and
   * the driven front axle pulled the car up to 0.7 m off its mark before the
   * green.
   */
  hold?: boolean;
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
