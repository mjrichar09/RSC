/**
 * A lap is recorded at the simulation's rate, whatever the frame rate.
 *
 * The board refuses a record that does not come with enough recording to have
 * set it (`GHOST_BYTES_PER_SECOND`, derived from a 60 Hz recorder). The live
 * loop used to sample once per rendered frame, so on a phone drawing 30 frames
 * a second every record came out at half that and was refused — and the
 * player was shown a personal best with no word of the world. This drives a
 * world the way a 30 fps device does and checks the lap would be accepted.
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world.js';
import { GhostRecorder } from '../src/sim/replay.js';
import { GHOST_BYTES_PER_SECOND } from '../server/src/board.js';

describe('recording a lap on a slow device', () => {
  it('samples at 60 Hz when the frames come at 30', async () => {
    const world = await createWorld();
    const recorder = new GhostRecorder();
    world.onStep = () => recorder.capture(world.time, 0, world.state());

    const seconds = 20;
    for (let frame = 0; frame < seconds * 30; frame++) {
      world.advance(1 / 30, { throttle: 1, brake: 0, steer: 0, handbrake: 0 });
    }

    const lap = recorder.finish('test', world.time);
    expect(recorder.frameCount / world.time).toBeGreaterThan(59);
    // What the board measures: base64 characters of the lap per second of it.
    const encoded = Math.ceil(lap.frames.byteLength / 3) * 4;
    expect(encoded / world.time).toBeGreaterThan(GHOST_BYTES_PER_SECOND);
  });
});
