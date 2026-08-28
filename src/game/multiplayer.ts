/**
 * One race, four cars, two kinds of player.
 *
 * This is the seam between the netcode and the game loop. Above it, `main.ts`
 * drives the same way it always has: sample the controls, advance the world,
 * draw the local car — which is index 0 whether you are hosting or not,
 * because the guest swapped its own car into that slot when it built the world.
 * Below it, one side is the authority and the other is arguing politely with
 * it, and neither the camera nor the HUD needs to know which.
 *
 * No three.js here, on purpose: a race between four cars can be run headlessly,
 * which is how the netcode is tested at all.
 */

import type { DriverInput } from '../sim/input.js';
import type { SimWorld } from '../sim/world.js';
import type { RaceHost } from '../net/host.js';
import type { RaceGuest } from '../net/guest.js';
import type { PlayerInfo, RaceSetup } from '../net/protocol.js';

export type Role = 'host' | 'guest';

export interface SessionOptions {
  world: SimWorld;
  setup: RaceSetup;
  /** Distance along the stage for a car, for the standings the host publishes. */
  progressOf: (car: number) => number;
}

export class MultiplayerSession {
  readonly role: Role;
  readonly setup: RaceSetup;
  /** Always zero. Kept as a name because the reason is not obvious. */
  readonly localCar = 0;

  private readonly host: RaceHost | null;
  private readonly guest: RaceGuest | null;
  private readonly world: SimWorld;
  private readonly progressOf: (car: number) => number;
  private accumulator = 0;

  constructor(side: { host?: RaceHost; guest?: RaceGuest }, options: SessionOptions) {
    this.host = side.host ?? null;
    this.guest = side.guest ?? null;
    this.role = this.host ? 'host' : 'guest';
    this.world = options.world;
    this.setup = options.setup;
    this.progressOf = options.progressOf;
  }

  get carCount(): number {
    return this.world.cars.length;
  }

  /** Player names by *local* car index, so the tags over the cars are right. */
  get names(): string[] {
    const players: PlayerInfo[] = this.host ? this.host.players : (this.guest?.players ?? []);
    return Array.from({ length: this.carCount }, (_, index) => {
      const hostIndex = this.toHost(index);
      return players.find((player) => player.car === hostIndex)?.name ?? '';
    });
  }

  /** True while the connection is up. A dropped guest keeps driving alone. */
  get connected(): boolean {
    return this.host ? true : (this.guest?.connected ?? false);
  }

  /** Round-trip time to the host in milliseconds, or null for the host itself. */
  get ping(): number | null {
    return this.guest?.rtt ?? null;
  }

  /** Local car index to the host's numbering. */
  toHost(index: number): number {
    if (!this.guest) return index;
    if (index === 0) return this.guest.car;
    if (index === this.guest.car) return 0;
    return index;
  }

  /**
   * Consume wall-clock seconds as fixed steps, returning the leftover fraction
   * for the renderer to interpolate with.
   *
   * The same accumulator `SimWorld.advance` uses, reimplemented here only
   * because each step has to go through the host or the guest — which is what
   * gets inputs onto the wire and snapshots off it at the right moments.
   */
  advance(elapsed: number, input: DriverInput): number {
    const dt = this.world.dt;
    this.accumulator = Math.min(this.accumulator + elapsed, 0.25);
    while (this.accumulator >= dt) {
      if (this.host) {
        this.host.step(input, dt);
        this.host.maybeSnapshot(dt, this.progressOf);
      } else {
        this.guest!.step(input, dt);
      }
      this.accumulator -= dt;
    }
    return this.accumulator / dt;
  }

  /** Tell everyone somebody finished. The host publishes; a guest sends it up. */
  report(car: number, time: number | null, retired: boolean): void {
    if (this.guest) {
      this.guest.report(time, retired);
      return;
    }
    const player = this.host?.players.find((p) => p.car === this.toHost(car));
    if (this.host && player) this.host.report(player.id, time, retired);
  }

  leave(): void {
    this.host?.shutdown();
    this.guest?.leave();
  }
}
