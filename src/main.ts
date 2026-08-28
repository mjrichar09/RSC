/**
 * Browser entry point.
 *
 * Wires the simulation to the renderer, the HUD and the race rules. The sim
 * advances on a fixed 120 Hz clock regardless of display refresh rate;
 * rendering interpolates between the last two steps.
 */

import { STAGES, stageById } from './data/stages/index.js';
import { TEST_PATCHES } from './data/testGround.js';
import { Career, type RaceTarget } from './game/career.js';
import { rollcageMitigation } from './game/garage.js';
import { Race } from './game/race.js';
import { SaveStore } from './game/save.js';
import { NEUTRAL_INPUT } from './sim/input.js';
import { Driver } from './sim/driver.js';
import { GhostPlayer, GhostRecorder } from './sim/replay.js';
import { COMPONENTS, FAILURE_LABEL, type ComponentId } from './sim/damage.js';
import { Stage, findVariant, type StageVariant, variantKey } from './sim/stage.js';
import { cornersAhead } from './sim/corners.js';
import { visibility } from './sim/conditions.js';
import { TRACES, sampleTrace } from './sim/trace.js';
import { SimWorld, initPhysics } from './sim/world.js';
import { Mixer } from './audio/mixer.js';
import { CarView } from './render/carView.js';
import { ParticleField, Precipitation, SkidMarks, emitDragSparks, updateWheelEffects } from './render/fx.js';
import { IsoCamera } from './render/camera.js';
import {
  keyLightOffset,
  addProvingGround,
  addSurfacePatches,
  createScene,
} from './render/scene.js';
import { buildStageView, type StageView } from './render/stageMesh.js';
import { Controls } from './ui/controls.js';
import { Hud } from './ui/hud.js';
import { RaceHud } from './ui/raceHud.js';
import { DamagePanel } from './ui/damagePanel.js';
import { DebrisView } from './render/debrisView.js';
import { WildlifeView } from './render/wildlifeView.js';
import { Garage } from './ui/garage.js';
import { LiveStageMap } from './ui/stageMap.js';
import { TuningPanel } from './ui/tuningPanel.js';

/**
 * Hooks the screenshot harness drives the game through, so a composite frame is
 * reproducible rather than whatever the game happened to be showing.
 */
interface HarnessHooks {
  ready: boolean;
  rendered: boolean;
  /**
   * Run a stage forward with the AI driver to `seconds`, then draw.
   * `crashFor` seconds of full lock into the embankment first, so a harness
   * frame can show real damage produced by the real impact pipeline rather
   * than by poking numbers into the model.
   */
  seekStage: (stageId: string, seconds: number, crashFor?: number, grip?: number) => void;
  /**
   * Drive a full AI lap, store it as the ghost, then replay a fresh run to
   * `seconds` so both cars are on screen. Used by the screenshot harness.
   */
  seedGhostAndSeek: (stageId: string, seconds: number) => Promise<void>;
  /** Run a proving-ground input trace to `seconds`, then draw. */
  seekTrace: (traceName: string, seconds: number) => void;
  draw: () => void;
  /** Text snapshot for the harness: cheaper to check than a screenshot. */
  status: () => Record<string, unknown>;
  /**
   * Drive the loaded stage to the finish with the AI and settle it, exactly as
   * a completed player run would be. Lets a whole career be exercised headlessly.
   */
  finishWithAi: (timeout?: number) => Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    RSC?: HarnessHooks;
  }
}

/** Seconds of being stuck before the car is put back on the road. */
const AUTO_RESCUE_AFTER = 3.5;

async function main(): Promise<void> {
  await initPhysics();

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hudRoot = document.getElementById('hud') as HTMLElement;
  const { renderer, scene, key, applyConditions, resize } = createScene(canvas);
  const camera = new IsoCamera();
  const carView = new CarView(scene);
  const ghostView = new CarView(scene, { ghost: true });
  const debrisView = new DebrisView(scene);
  // The minimap. Fixed north-up, so the shape of a stage can be learned.
  const minimap = new LiveStageMap(hudRoot, 'minimap');
  const wildlifeView = new WildlifeView(scene);
  ghostView.visible = false;
  const particles = new ParticleField(scene);
  const skids = new SkidMarks(scene);
  const precipitation = new Precipitation(scene);
  const mixer = new Mixer();
  const hud = new Hud(hudRoot);
  const raceHud = new RaceHud(hudRoot);
  const damagePanel = new DamagePanel(hudRoot);
  const controls = new Controls();
  const save = new SaveStore();
  await save.open();
  const career = new Career(save, STAGES);

  const params = new URLSearchParams(location.search);
  const freeRoam = params.has('free') || params.has('trace');

  let world: SimWorld;
  let stage: Stage | null = null;
  let race: Race | null = null;
  let stageView: StageView | null = null;
  let variant: StageVariant | null = null;

  /**
   * The stage-and-conditions pairing currently loaded. Fees, payouts, records
   * and ghosts all key off this rather than off the stage alone: a night run is
   * its own race.
   */
  const currentTarget = (): RaceTarget => ({ def: stage!.def, variant: variant! });
  const currentKey = (): string => variantKey(stage!.def.id, variant!.id);
  let tuningPanel: TuningPanel | null = null;
  let stuckFor = 0;
  let ghost: GhostPlayer | null = null;
  const recorder = new GhostRecorder();

  /**
   * The car's condition when this stage session began.
   *
   * A restart re-runs the attempt from the condition you arrived in, not from
   * a factory-fresh car — otherwise a bad crash could be undone for nothing and
   * the damage economy would mean nothing.
   */
  /**
   * When set, the camera stays here instead of following the car. Harness only:
   * `drawOnce` calls `camera.follow`, so a jump made before drawing is undone
   * by the very frame it was made for.
   */
  let cameraLock: { at: { x: number; y: number; z: number }; zoom: number | null } | null = null;
  let sessionHealth: Partial<Record<ComponentId, number>> = {};
  let settled = false;

  /** Show the stored best for this pairing, and start chasing its ghost. */
  const attachGhost = async (key: string) => {
    const record = save.recordFor(key);
    raceHud.setBest(record?.time ?? null);

    const stored = await save.loadGhost(key);
    // Guard against the player switching stage or variant while this loaded.
    if (!stage || !variant || currentKey() !== key) return;
    ghost = stored ? new GhostPlayer(stored) : null;
    ghostView.visible = ghost !== null;
  };

  const loadStage = (stageId: string, variantId?: string) => {
    stageView?.dispose();
    if (stageView) scene.remove(stageView.group);

    const def = stageById(stageId);
    variant = findVariant(def, variantId);
    stage = new Stage(def);

    // Conditions light the scene, set the fog, and decide how much the
    // headlights matter — which is what finally gives the `lights` component
    // something to do.
    applyConditions(variant.conditions);
    precipitation.setWeather(variant.conditions.weather);
    carView.setHeadlightWeight(visibility(variant.conditions).headlightWeight);
    stageView = buildStageView(stage);
    scene.add(stageView.group);

    // Damage is on for stages and off for the proving ground: the handling
    // tests and the tuning sweep are measuring the car, not the crashing.
    world = new SimWorld({
      stage,
      tuning: career.tuning(),
      damage: { rollcage: rollcageMitigation(career.upgrades) },
      conditions: variant.conditions,
    });
    applyCarCondition();
    race = new Race(stage, variant.medals);
    settled = false;
    damagePanel.reset();
    raceHud.setStage(stage, variant.name, variant.medals);
    minimap.setStage(stage);
    tuningPanel?.rebind(world.vehicle.tuning);

    camera.applyZones(stage.cameraZones, 0);
    camera.jumpTo(world.state().position);
    stuckFor = 0;
    particles.clear();
    skids.clear();

    ghost = null;
    ghostView.visible = false;
    recorder.reset();
    void attachGhost(currentKey());
  };

  /** Seed the world's damage model with the condition the car is actually in. */
  const applyCarCondition = () => {
    if (!world.damage) return;
    for (const [id, health] of Object.entries(sessionHealth)) {
      if (typeof health === 'number') world.damage.health.set(id as ComponentId, health);
    }
    world.damage.refreshFailures();
  };

  const loadFreeRoam = () => {
    addProvingGround(scene);
    addSurfacePatches(scene, TEST_PATCHES);
    world = new SimWorld({ baseSurface: 'tarmac', patches: TEST_PATCHES });
    camera.jumpTo(world.state().position);
  };

  if (freeRoam) loadFreeRoam();
  else {
    sessionHealth = { ...career.profile.carHealth };
    loadStage(params.get('stage') ?? STAGES[0]!.id, params.get('variant') ?? undefined);
  }

  tuningPanel = new TuningPanel(hudRoot, world!.vehicle.tuning);
  controls.onToggleTuning = () => tuningPanel!.toggle();

  const restart = () => {
    if (stage && race) {
      // Each attempt on a paid stage costs its fee again: that is what makes a
      // committed run different from an idle retry. The free stage stays freely
      // retryable, so the Trackmania practice loop survives intact.
      //
      // Any attempt that actually started counts, not just one that was settled.
      // Charging only on settled runs let a player crash at nine tenths
      // distance, restart for nothing, and discard the damage with it — which
      // costs the damage economy most of its meaning.
      const attemptUsed = race.phase !== 'staging';
      if (stage.def.entryFee > 0 && attemptUsed) {
        if (!career.canEnter(currentTarget()).allowed) {
          openGarage();
          return;
        }
        void career.enter(currentTarget());
      }
      world.vehicle.reset(stage.start.position, stage.start.heading);
      race.reset();
      raceHud.setStage(stage, variant?.name, variant?.medals);
      raceHud.setBest(save.recordFor(currentKey())?.time ?? null);
      raceHud.setSplitDeltas([]);
      raceHud.setDelta(null);
      recorder.reset();
      world.damage?.reset();
      world.clearDebris();
      debrisView.clear();
      wildlifeView.clear();
      applyCarCondition();
      particles.clear();
      skids.clear();
      settled = false;
      raceHud.setLedger(null);
      damagePanel.reset();
      camera.applyZones(stage.cameraZones, 0);
    } else {
      world.vehicle.reset({ x: 0, y: 1.2, z: 0 }, 0);
    }
    camera.jumpTo(world.state().position);
    stuckFor = 0;
  };

  controls.onReset = restart;
  controls.onRescue = () => {
    world.rescue(race?.furthest);
    stuckFor = 0;
  };
  const garage = new Garage(hudRoot, career);
  garage.onEnter = (target) => {
    // The fee is taken by the garage; this is the condition the attempt starts
    // from, and the one a restart returns to.
    sessionHealth = { ...career.profile.carHealth };
    loadStage(target.def.id, target.variant.id);
  };

  const openGarage = () => {
    if (freeRoam) return;
    // Bank whatever happened before leaving, so damage is never lost by walking
    // away from a half-finished run.
    if (race && race.phase === 'running') void settleRun(true);
    garage.setOpen(true);
  };

  // Browsers refuse to start audio without a gesture, so the graph is built on
  // the first interaction and the game is silent but playable until then.
  const startAudio = () => mixer.start();
  window.addEventListener('keydown', startAudio, { once: true });
  window.addEventListener('pointerdown', startAudio, { once: true });

  controls.onMute = () => mixer.toggleMute();

  controls.onGarage = () => {
    if (freeRoam) return;
    if (garage.isOpen) garage.setOpen(false);
    else openGarage();
  };
  controls.onSelectStage = (index) => {
    if (freeRoam) return;
    if (garage.isOpen) void garage.enterByIndex(index);
  };

  /**
   * Settle a finished or retired attempt: pay out, carry the damage forward,
   * and store the ghost if it was a new best.
   */
  const settleRun = async (retired: boolean) => {
    if (!stage || !race || settled || !world.damage) return;
    settled = true;

    const time = race.finishTime;
    const previous = save.recordFor(currentKey())?.time ?? null;

    const result = await career.settle(currentTarget(), {
      medal: race.medal,
      time,
      retired,
      damage: world.damage,
      ...(retired || time === null ? {} : { ghost: recorder.finish(currentKey(), time) }),
    });

    raceHud.setLedger(result);
    if (result.newRecord && time !== null) {
      raceHud.setBest(time);
      raceHud.markRecord(previous);
      await attachGhost(currentKey());
    }
  };

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    resize(w, h);
    camera.resize(w, h);
  };

  /** Screen pixels per world metre under the orthographic camera. */
  const updateParticleScale = () => {
    particles.setScale(window.innerHeight / (2 * camera.effectiveViewSize));
  };
  window.addEventListener('resize', onResize);
  onResize();

  const drawOnce = (alpha: number, dt: number) => {
    const state = world.state();
    const transform = world.renderTransform(alpha);
    carView.update(transform, state, world.damage, world.debris);
    debrisView.update(world.loose);
    // Turn the corner boards to face the camera. Cheap — there are a handful —
    // and it is the only way they stay readable through a zone change.
    for (const board of stageView?.signBoards ?? []) board.rotation.y = camera.yaw;
    wildlifeView.update(world.wildlife?.animals ?? []);

    if (ghost && race) {
      const sample = ghost.sampleAt(race.time);
      if (sample) ghostView.updateFromGhost(sample);
      // Hide it once its run has ended rather than freezing a car on the road.
      ghostView.visible = race.time <= ghost.duration + 0.5;
    }

    if (stage && race) camera.applyZones(stage.cameraZones, race.furthest);
    if (cameraLock) {
      camera.jumpTo(cameraLock.at);
      // After the jump, because `jumpTo` takes its view size from the zone the
      // line above just applied — which is how a locked frame ended up at the
      // stage's own zoom rather than the one asked for.
      if (cameraLock.zoom !== null) camera.setViewSize(cameraLock.zoom);
    } else {
      camera.follow(dt, transform.position, state.velocity);
    }

    // The shadow frustum is far too tight to cover a whole stage, so it rides
    // along with the car — and its azimuth tracks the camera, so the shadow
    // never ends up hidden behind the car whatever a zone's yaw is.
    const sun = keyLightOffset(camera.yaw);
    key.position.set(
      transform.position.x + sun.x,
      transform.position.y + sun.y,
      transform.position.z + sun.z,
    );
    key.target.position.set(transform.position.x, transform.position.y, transform.position.z);
    key.target.updateMatrixWorld();

    renderer.render(scene, camera.camera);
  };

  window.RSC = {
    ready: true,
    rendered: false,
    seekStage(stageId, seconds, crashFor = 0, grip = 0.6) {
      // Reuse the loaded stage when possible: reloading would drop the ghost
      // that seedGhostAndSeek has just attached.
      if (!stage || stage.def.id !== stageId) loadStage(stageId);
      else restart();
      const driver = new Driver(stage!, { gripBudget: grip });
      for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
      world.time = 0;
      while (world.time < seconds) {
        world.step(driver.input(world.state(), world.dt));
        race!.update(world.state(), world.dt);
        // Accumulate spray and marks so a harness frame shows the same effects
        // a player would see, rather than a suspiciously clean road.
        updateWheelEffects(particles, skids, world.state().wheels, world.state().velocity, world.dt);
        particles.update(world.dt);
      }
      if (crashFor > 0) {
        const until = world.time + crashFor;
        while (world.time < until) {
          world.step({ throttle: 1, brake: 0, steer: 1, handbrake: 0 });
          race!.update(world.state(), world.dt);
          updateWheelEffects(particles, skids, world.state().wheels, world.state().velocity, world.dt);
          particles.update(world.dt);
          const failure = [...(world.damage?.failures ?? [])][0];
          if (failure) race!.retire(FAILURE_LABEL[failure]);
        }
        damagePanel.report(world.damage!.drainEvents());
      }
      raceHud.setSplitDeltas(
        race!.splits.map((split) => {
          const at = ghost?.timeAtDistance(split.distance);
          return at === null || at === undefined ? null : split.time - at;
        }),
      );

      // Pose the ghost for the same moment, so a harness frame shows the chase.
      if (ghost) {
        const sample = ghost.sampleAt(race!.time);
        if (sample) ghostView.updateFromGhost(sample);
        ghostView.visible = race!.time <= ghost.duration + 0.5;
        const ghostAt = ghost.timeAtDistance(race!.furthest);
        raceHud.setDelta(ghostAt === null ? null : race!.time - ghostAt);
      }
      camera.applyZones(stage!.cameraZones, race!.furthest);
      camera.jumpTo(world.state().position);
      raceHud.update(race!, world.damage);
      raceHud.setNotes(cornersAhead(stage!.corners, race!.furthest, 2));
      minimap.update(world.state().position, race!.progress);
      damagePanel.update(world.damage!);
      hud.update(world.state(), 60);
    },
    async seedGhostAndSeek(stageId, seconds) {
      if (!stage || stage.def.id !== stageId) loadStage(stageId);
      const driver = new Driver(stage!);
      for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
      world.time = 0;

      // A full lap first, recorded exactly as a player's run would be.
      while (race!.phase !== 'finished' && world.time < 240) {
        world.step(driver.input(world.state(), world.dt));
        race!.update(world.state(), world.dt);
        if (race!.phase === 'running') {
          recorder.capture(race!.time, race!.furthest, world.state());
        }
      }
      if (race!.phase === 'finished' && race!.medal) {
        await settleRun(false);
      }

      restart();
      await attachGhost(currentKey());
      this.seekStage(stageId, seconds);
    },
    seekTrace(traceName, seconds) {
      const trace = TRACES[traceName];
      if (!trace) throw new Error(`unknown trace: ${traceName}`);
      world.vehicle.reset({ x: 0, y: 1.2, z: 0 }, 0);
      world.time = 0;
      while (world.time < seconds) world.step(sampleTrace(trace, world.time));
      camera.jumpTo(world.state().position);
      hud.update(world.state(), 60);
    },
    draw() {
      updateParticleScale();
      precipitation.update(1 / 60, camera.focus, window.innerHeight / (2 * camera.effectiveViewSize));
      drawOnce(1, 1 / 60);
      window.RSC!.rendered = true;
    },
    async finishWithAi(timeout = 240) {
      if (!stage || !race) return { error: 'no stage loaded' };
      const driver = new Driver(stage);
      for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
      world.time = 0;

      let stuck = 0;
      while (race.phase !== 'finished' && race.phase !== 'retired' && world.time < timeout) {
        world.step(driver.input(world.state(), world.dt));
        race.update(world.state(), world.dt);
        if (race.phase === 'running') recorder.capture(race.time, race.furthest, world.state());

        const failure = [...(world.damage?.failures ?? [])][0];
        if (failure && race.phase === 'running') race.retire(FAILURE_LABEL[failure]);

        if (race.phase === 'running' && Math.abs(world.state().speed) < 1) {
          stuck += world.dt;
          if (stuck > AUTO_RESCUE_AFTER) {
            world.rescue(race.furthest);
            stuck = 0;
          }
        } else {
          stuck = 0;
        }
      }

      await settleRun(race.phase === 'retired');
      raceHud.update(race, world.damage);
      // The co-driver reads from the same corner list the boards are built
      // from, so a note can never disagree with a sign.
      raceHud.setNotes(cornersAhead(stage.corners, race.furthest, 2));
      minimap.update(world.state().position, race.progress);
      return this.status();
    },
    status() {
      const d = world.damage;
      return {
        stage: stage?.def.id ?? 'free',
        phase: race?.phase ?? 'n/a',
        money: career.money,
        medal: race?.medal ?? null,
        time: race?.time.toFixed(2),
        condition: d ? +(d.condition * 100).toFixed(1) : null,
        bill: d?.repairBill().total ?? null,
        worst: d
          ? d
              .repairBill()
              .lines.slice(0, 3)
              .map((l) => l.label)
          : null,
        failures: d ? [...d.failures] : [],
        dragging: world.debris?.dragging() ?? [],
        shed: world.loose.map((l) => l.id),
        temp: d ? +d.temperature.toFixed(2) : null,
      };
    },
  };

  const harnessTrace = params.get('trace');
  const harnessSeek = params.get('t');
  if (harnessTrace) {
    window.RSC.seekTrace(harnessTrace, Number(harnessSeek ?? '3'));
    window.RSC.draw();
    return;
  }
  if (harnessSeek) {
    const id = params.get('stage') ?? STAGES[0]!.id;
    if (params.has('ghost')) await window.RSC.seedGhostAndSeek(id, Number(harnessSeek));
    else {
      window.RSC.seekStage(
        id,
        Number(harnessSeek),
        Number(params.get('crash') ?? '0'),
        Number(params.get('grip') ?? '0.6'),
      );
    }
    // `?brakes=650` preheats the discs. Brake glow starts at a temperature the
    // AI does not reach on a clean lap, so the only way to check how it looks
    // is to put the heat there directly.
    // `?loosen=15000` puts one impact's worth of N·s through the nose mounts,
    // then runs on a couple of seconds so the parts do what they were going to
    // do. The visual question — does a dragging bumper read as dragging — is
    // otherwise only answerable by crashing until it happens.
    // `?wreck=18000` puts a few impacts of that size through the nose, a
    // flank and the tail. Crashing into scenery until the car looks right is a
    // slow way to answer "does the crumple read".
    const wreck = params.get('wreck');
    if (wreck && world!.damage) {
      const impulse = Number(wreck);
      for (const at of [
        { x: 0, y: 0, z: 1.9 },
        { x: -0.9, y: 0, z: 0.6 },
        { x: 0.9, y: 0.1, z: -1.2 },
        { x: 0, y: 0.3, z: -1.9 },
      ]) {
        world!.damage.applyImpact(at, impulse);
        world!.debris?.applyImpact(at, impulse);
      }
      // A moment of driving so the parts settle into their new poses, then put
      // the camera back on the car it just beat up.
      for (let i = 0; i < 30; i++) world!.step({ throttle: 0.3, brake: 0, steer: 0, handbrake: 0 });
      camera.jumpTo(world!.state().position);
      if (world!.damage) damagePanel.update(world!.damage);
    }

    const loosen = params.get('loosen');
    if (loosen) {
      world!.debris?.applyImpact({ x: 0, y: 0, z: 1.9 }, Number(loosen));
      const state = () => world!.state();
      for (let i = 0; i < 120 * Number(params.get('after') ?? '2'); i++) {
        world!.step({ throttle: 0.35, brake: 0, steer: 0, handbrake: 0 });
        updateWheelEffects(particles, skids, state().wheels, state().velocity, world!.dt);
        // Sparks too, or a harness frame of a dragging bumper shows the pose
        // without the shower that is the actual telegraph.
        for (const id of world!.debris?.dragging() ?? []) {
          const at = carView.dragPoint(id);
          if (at) emitDragSparks(particles, at, state().velocity, Math.abs(state().speed), world!.dt);
        }
        particles.update(world!.dt);
      }
      camera.jumpTo(world!.state().position);
    }
    // `?sign=2` puts the camera on that corner board, for reading the arrow.
    const signIndex = params.get('sign');
    if (signIndex) {
      const sign = stage!.signs[Number(signIndex)];
      // Aim at the board itself, not at the foot of its post.
      const zoomParam = params.get('zoom');
      if (sign) {
        cameraLock = {
          at: { x: sign.position.x, y: sign.position.y + 2.6, z: sign.position.z },
          zoom: zoomParam ? Number(zoomParam) : null,
        };
      }
    }

    const brakes = params.get('brakes');
    if (brakes) world!.damage?.brakeTemp.fill(Number(brakes));
    // `?zoom=8` pulls the orthographic camera in. Detail on the car itself —
    // a brake disc is about a metre across — is invisible at race distance.
    const zoom = params.get('zoom');
    if (zoom) camera.setViewSize(Number(zoom));
    window.RSC.draw();
    return;
  }

  // `?wreckCar=20000` puts a wrecked car in the garage, so the turntable and
  // the repair list can be looked at together without crashing one first.
  const wreckCar = params.get('wreckCar');
  if (wreckCar) {
    const model = career.buildDamage();
    for (const at of [
      { x: 0, y: 0, z: 1.9 },
      { x: -0.9, y: 0.1, z: 0.6 },
      { x: 0.9, y: 0.1, z: -1.2 },
    ]) {
      model.applyImpact(at, Number(wreckCar));
    }
    const health: Partial<Record<ComponentId, number>> = {};
    for (const component of COMPONENTS) health[component.id] = model.get(component.id);
    await save.update((profile) => {
      profile.carHealth = health;
    });
  }

  // Start in the garage: the first decision the game asks for is which stage to
  // spend money on, not which corner to take.
  if (!freeRoam) garage.setOpen(true);

  let last = performance.now();
  let fps = 60;

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.08;

    // The world keeps stepping behind the garage so the scene stays alive, but
    // it takes no input while a menu is up.
    const input = garage.isOpen ? NEUTRAL_INPUT : controls.sample(dt);
    const alpha = world.advance(dt, input);

    const state = world.state();
    if (race && stage) {
      const wasRunning = race.phase === 'running';
      const splitsBefore = race.splits.length;
      race.update(state, dt);

      // A bump the car shrugs off should still be felt and heard, so this reads
      // the raw impulse rather than waiting for a damage event.
      if (world.lastImpact > 1200) {
        const severity = Math.min((world.lastImpact - 1200) / 26_000, 1);
        camera.shake(severity);
        mixer.impact(severity);
      }

      // What happened first, then what it broke.
      for (const notice of world.drainNotices()) damagePanel.notice(notice);

      // Surface what just broke while the impact is still on screen.
      if (world.damage) {
        damagePanel.report(world.damage.drainEvents());
        damagePanel.update(world.damage);

        const failure = [...world.damage.failures][0];
        if (failure && race.phase === 'running') race.retire(FAILURE_LABEL[failure]);
      }

      if (race.phase === 'running') {
        recorder.capture(race.time, race.furthest, state);

        // Live delta: when did the ghost reach the point we have reached?
        const ghostTime = ghost?.timeAtDistance(race.furthest) ?? null;
        raceHud.setDelta(ghostTime === null ? null : race.time - ghostTime);
      }

      if (race.splits.length !== splitsBefore) {
        raceHud.setSplitDeltas(
          race.splits.map((split) => {
            const at = ghost?.timeAtDistance(split.distance);
            return at === null || at === undefined ? null : split.time - at;
          }),
        );
      }

      if (wasRunning && (race.phase === 'finished' || race.phase === 'retired')) {
        void settleRun(race.phase === 'retired');
      }

      raceHud.update(race);
      // The co-driver's call and the minimap both read the corner list and the
      // progress the race is already tracking.
      if (stage) {
        raceHud.setNotes(cornersAhead(stage.corners, race.furthest, 2));
        minimap.update(state.position, race.progress);
      }

      // Beaching the chassis across the verge with all four wheels dangling is
      // unrecoverable by driving, so the game recovers for you.
      if (race.phase === 'running' && Math.abs(state.speed) < 1) {
        stuckFor += dt;
        if (stuckFor > AUTO_RESCUE_AFTER) {
          world.rescue(race.furthest);
          stuckFor = 0;
        }
      } else {
        stuckFor = 0;
      }
    }

    // Spray, marks and sound all read straight off tyre saturation — the same
    // number the physics uses — so what you see and hear is what is happening.
    if (!garage.isOpen) {
      updateWheelEffects(particles, skids, state.wheels, state.velocity, dt);
      // Anything scraping along the road throws sparks from where it touches.
      for (const id of world.debris?.dragging() ?? []) {
        const at = carView.dragPoint(id);
        if (at) emitDragSparks(particles, at, state.velocity, Math.abs(state.speed), dt);
      }
      mixer.update(state, {
        maxRpm: world.vehicle.tuning.maxRpm,
        throttle: input.throttle,
        engineHealth: world.damage?.get('engine') ?? 1,
        turboHealth: world.damage?.get('turbo') ?? 1,
        misfiring: world.damage?.effects().misfiring ?? false,
        dt,
      });
    } else {
      mixer.quiet();
    }
    particles.update(dt);
    updateParticleScale();
    precipitation.update(dt, camera.focus, window.innerHeight / (2 * camera.effectiveViewSize));

    drawOnce(alpha, dt);
    // The visual harness waits on this, so the live loop has to set it too or
    // a garage screenshot waits for a frame that only the seek path reports.
    window.RSC!.rendered = true;
    hud.update(state, fps);
    tuningPanel!.update(state);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:absolute;top:0;left:0;padding:20px;color:#e8552f">${String(err)}</pre>`,
  );
});
