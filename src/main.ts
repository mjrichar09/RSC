/**
 * Browser entry point.
 *
 * Wires the simulation to the renderer, the HUD and the race rules. The sim
 * advances on a fixed 120 Hz clock regardless of display refresh rate;
 * rendering interpolates between the last two steps.
 */

import { STAGES, stageById } from './data/stages/index.js';
import { liveryById } from './data/liveries.js';
import { TEST_PATCHES } from './data/testGround.js';
import { Career, type RaceTarget } from './game/career.js';
import { carFor } from './game/garage.js';
import { boardFor } from './net/leaderboard.js';
import { Race } from './game/race.js';
import { ImpactDrama } from './game/drama.js';
import {
  CrashReel,
  EMPTY_REEL_FRAME,
  RecordedDamage,
  RecordedDebris,
  type ReelFrame,
  type ReelImpact,
} from './game/crashReel.js';
import { TouchControls } from './ui/touch.js';
import { isTyping } from './ui/typing.js';
import { type QualityTier, RenderScale, guessTier, qualityFor } from './render/quality.js';
import { useRelay } from './net/webrtc.js';
import { StartLights } from './game/startLights.js';
import { awardsFor, boardAwards } from './game/awards.js';
import { Celebrations } from './ui/celebrate.js';
import { SaveStore } from './game/save.js';
import { type DriverInput, NEUTRAL_INPUT } from './sim/input.js';
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
import { EasedDamage } from './render/foldEase.js';
import {
  ParticleField,
  Precipitation,
  SkidMarks,
  emitCrashDebris,
  emitDragSparks,
  emitImpactBurst,
  emitImpactSparks,
  emitSteam,
  updateWheelEffects,
} from './render/fx.js';
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
import { MultiplayerPanel } from './ui/multiplayer.js';
import { UpdateBanner, UpdateWatch } from './ui/update.js';
import { StartMenu } from './ui/menu.js';
import { ReplayUi } from './ui/replay.js';
import { MultiplayerSession } from './game/multiplayer.js';
import { LiveStageMap } from './ui/stageMap.js';
import * as THREE from 'three';
import { rotate, type Vec3 } from './sim/math.js';
import type { VehicleState } from './sim/vehicle.js';
import { Vision } from './sim/vision.js';
import { VisionPass } from './render/vision.js';
import { gradeFor } from './render/grade.js';
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
  /**
   * How hard to work this machine's GPU.
   *
   * `?quality=low|medium|high` overrides the guess, which is what the mobile
   * harness uses and what a player with a phone the guess got wrong can use.
   */
  const tierParam = new URLSearchParams(location.search).get('quality') as QualityTier | null;
  const quality = qualityFor(
    tierParam === 'low' || tierParam === 'medium' || tierParam === 'high' ? tierParam : guessTier(),
  );
  const renderScale = new RenderScale();
  const { renderer, scene, key, applyConditions, resize } = createScene(canvas, quality);
  const camera = new IsoCamera();
  const carView = new CarView(scene);
  const ghostView = new CarView(scene, { ghost: true });
  const debrisView = new DebrisView(scene);
  // The minimap. Fixed north-up, so the shape of a stage can be learned.
  const minimap = new LiveStageMap(hudRoot, 'minimap');
  const vision = new Vision();
  /**
   * Advance what the driver can see. Shared by the render loop and the visual
   * harness — soiling accumulates over seconds, so a harness frame that only
   * ever advances it once shows a spotless screen in a downpour.
   */
  const advanceVision = (dt: number) => {
    const state = world.state();
    return vision.update(dt, {
      conditions: world.conditions,
      speed: Math.abs(state.speed),
      surface: state.wheels.find((w) => w.grounded)?.surface.id ?? 'tarmac',
      wiperHealth: world.damage?.get('wipers') ?? 1,
      windscreenHealth: world.damage?.get('windscreen') ?? 1,
      lightHealth: world.damage?.get('lights') ?? 1,
    });
  };
  const visionPass = new VisionPass(renderer);
  /** Reused for the screen-space projection each frame. */
  const SCRATCH = new THREE.Vector3();
  const wildlifeView = new WildlifeView(scene);
  ghostView.visible = false;
  const particles = new ParticleField(scene);
  particles.density = quality.particles;
  /**
   * A second pool, for what a crash throws off.
   *
   * Not a tidiness split — a correctness one. Wheel spray on a loose surface
   * fills the shared ring at about 2 400 particles a second, and a crash
   * happens while the car is sliding on gravel with every wheel spraying: the
   * measurement was that *every* shard of debris was recycled within half a
   * second of a three-second lifetime, so the sparks, the dust and the debris
   * were all real, all emitted, and all gone before anybody could see them.
   *
   * Its own field cannot be evicted, holds its brightness while the debris
   * lies there (`fade` well under 1), and can be run on the replay's clock
   * during the cinematic while the spray stays frozen.
   */
  const impacts = new ParticleField(scene, 320);
  impacts.density = quality.particles;
  impacts.fade = 0.6;
  const skids = new SkidMarks(scene);
  const precipitation = new Precipitation(scene);
  const mixer = new Mixer();
  /**
   * On-screen controls, off until something touches the screen.
   *
   * Detected rather than sniffed: a laptop with a touchscreen is a keyboard
   * machine until somebody actually uses a finger on it, and a tablet with a
   * keyboard attached is the same in reverse. The first real touch decides,
   * and a key press decides back.
   */
  const touch = new TouchControls(hudRoot);
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType !== 'touch') return;
      touch.setVisible(true);
      // And ask for fullscreen from *this* gesture, whatever it was for.
      //
      // It used to be asked for on the first thumb on the steering pad, which
      // is the first gesture of the race — so Android's "now full screen"
      // toast landed across the start countdown every single time. Any touch
      // will carry the request, so the earliest one takes it: by the time the
      // lights run, the toast has been and gone. Here rather than inside
      // `TouchControls` because the request is refused while the controls are
      // hidden, and this is the line that shows them.
      touch.requestFullscreen();
    },
    { capture: true },
  );
  // A key press means a keyboard machine — unless it came from the on-screen
  // keyboard the phone put up for a text field, which is every character of a
  // name or a room code. That used to take the thumb controls away mid-lobby.
  window.addEventListener(
    'keydown',
    () => {
      if (isTyping()) return;
      touch.setVisible(false);
    },
    { capture: true },
  );

  const hud = new Hud(hudRoot);
  const raceHud = new RaceHud(hudRoot);
  const damagePanel = new DamagePanel(hudRoot);
  const controls = new Controls();
  const save = new SaveStore();
  await save.open();
  const career = new Career(save, STAGES);

  /** Bright torn road where bodywork has been dragged along it. */
const SCRAPE_COLOR = new THREE.Color(0xb9b2a4);
/** The ground going up at an impact, in whatever the ground is made of. */
const BURST_COLOR = new THREE.Color();

/**
 * The crash cinematic's window, in real seconds either side of the impact.
 *
 * The lead is the run-up — enough to see the car arrive at whatever it hit and
 * understand why. The lag is the part the replay used to be missing entirely:
 * the strip was taken on the frame the impact was *detected*, so it ended with
 * the car straight and intact and the crash happened after the last frame of
 * the recording of it. Half a second of real time is about a second and a half
 * of playback at 0.34×, which covers the fold, the parts leaving and the car
 * coming to rest — and it is short enough that the cut still reads as a
 * reaction to the hit rather than an afterthought.
 */
const REPLAY_LEAD = 1.25;
const REPLAY_LAG = 0.5;

const params = new URLSearchParams(location.search);
  // `?vision=0.6` scales the whole windscreen effect. It is the setting most
  // likely to need a human eye, so it is adjustable rather than baked in.
  const visionParam = params.get('vision');
  // `?drama=0` runs the visual harness at real time, which every screenshot
  // wants: a frame captured mid-dilation is a frame of a different run.
  const dramaParam = params.get('drama');
  // `?turn=turn:host:3478|user|password` points the handshake at a relay. STUN
  // cannot get through a NAT that hands out a different port per destination,
  // and the game has no server of its own to bounce off.
  useRelay(params.get('turn'));
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
  /**
   * The network race, when there is one. The local car is index 0 either way —
   * a guest swaps its own car into that slot — so everything below this point
   * is written as if there were only ever one car, exactly as it was.
   */
  /**
   * Which game this is.
   *
   * Career keeps the car: damage carries, repairs cost money, stages unlock.
   * Arcade keeps nothing — every stage open, free entry, a fixed car every
   * time, and no record of what you did to it.
   */
  let mode: 'career' | 'arcade' = 'career' as 'career' | 'arcade';
  let session: MultiplayerSession | null = null;
  /** Views for the other cars in a network race, by car index. */
  let rivalViews: CarView[] = [];
  const tagLayer = document.createElement('div');
  tagLayer.className = 'tags';
  hudRoot.appendChild(tagLayer);
  let stuckFor = 0;
  /**
   * What the car was last actually given, for the status readout.
   *
   * Declared up here rather than beside the frame loop, which is where it was
   * and where it could not be: `window.RSC.status()` reads it, and the visual
   * harness calls that before the first frame has run — so every `npm run
   * shoot` died on `Cannot access 'lastInput' before initialization`, a
   * temporal dead zone error pointing at a line that looked fine. Anything the
   * status readout touches has to be initialised before the harness can ask.
   */
  let lastInput: DriverInput = NEUTRAL_INPUT;
  /**
   * How hard the impact was that the camera has already been knocked for, N·s.
   *
   * Decays every frame, so it is a bar the next hit has to clear rather than a
   * lockout. See the shake in the frame loop for why one is needed.
   */
  let shakenFor = 0;
  /**
   * The countdown on the gantry. The car is held while it runs, so a jumped
   * start is impossible rather than penalised — and every time recorded before
   * this existed stays comparable, because the clock still starts on the car's
   * first movement.
   */
  const lights = new StartLights();
  // Time dilation and a ducked mix on a big hit. `?drama=0` switches both off
  // outright, as does the K key and the stored setting behind it — the effect
  // is a taste call and has to be removable without touching any other code.
  const drama = new ImpactDrama();
  /** What a run was worth beyond the money, said out loud. */
  const celebrations = new Celebrations(hudRoot);
  celebrations.onLand = (award) => mixer.fanfare(award.weight);
  /** Set by the photo-mode save key; read at the end of the next frame. */
  let wantsCapture = false;
  /**
   * A failure the car cannot continue from, and how long it has been stopped.
   *
   * The race does not end at the moment something breaks. The engine dies, and
   * the car coasts: it still steers, still brakes, and if the line is close
   * enough it still crosses it. Ending the run the instant a component failed
   * threw away the most dramatic twenty seconds a race can have.
   */
  let terminal: { label: string; stopped: number } | null = null;
  /**
   * Photo mode. While this is open the world does not advance and the car is
   * posed from the run's own recording.
   */
  const replayUi = new ReplayUi(hudRoot);
  let ghost: GhostPlayer | null = null;
  const recorder = new GhostRecorder();
  /**
   * Real seconds left before the armed cinematic cuts in, or 0 for none.
   *
   * The replay used to be taken and opened on the frame the impact was
   * detected, so its last frame *was* the impact and the crash it was there to
   * show had not happened yet: the strip ended with the car straight and
   * intact, a moment before everything interesting. Waiting half a second and
   * taking the strip then puts the fold, the parts leaving and the car coming
   * to rest inside it.
   *
   * Declared up here rather than beside the cinematic that reads it: `loadStage`
   * clears it and runs during boot, so a `let` further down this very long
   * function is in its temporal dead zone and the whole game fails to start.
   */
  let crashReplayIn = 0;
  /**
   * The damage the *renderer* shows, which lags the real thing by a tenth of a
   * second so a fold is seen to arrive rather than to appear.
   *
   * Only the local car. Rival cars keep reading their live models: they are
   * seen from across a stage, the cinematic never poses them, and four of these
   * would be four more things to remember to advance.
   */
  const shownDamage = new EasedDamage();

  /**
   * The last couple of seconds, for the crash cinematic.
   *
   * Separate from the ghost recorder because they answer different questions. A
   * ghost is where the car *went*, saved to disk and compared across sessions,
   * so its format has to stay small and stable. This is what the crash *looked
   * like* — damage, parts, the deer — and it is thrown away as soon as it has
   * been watched.
   */
  const crashReel = new CrashReel();
  const reelDamage = new RecordedDamage(EMPTY_REEL_FRAME);
  const reelDebris = new RecordedDebris(EMPTY_REEL_FRAME);

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

  /**
   * Paint for the other cars. Distinct hues rather than shades: at a fixed
   * isometric distance, in a dust cloud, hue is the only thing that reads.
   */
  const RIVAL_PAINT = [0xd8563a, 0x4d86d6, 0x5fbf7a];

  /**
   * Paint for the other cars.
   *
   * In a lobby everyone picks their own, and that choice is the only thing
   * that makes a multiplayer car theirs — the car itself is fresh for
   * everybody. Falls back to the fixed hues for the AI and for anyone who has
   * not chosen.
   */
  let rivalLiveries: { livery: string; number: number }[] = [];

  const buildRivalViews = (cars: number) => {
    for (const view of rivalViews) scene.remove(view.group);
    rivalViews = [];
    for (let i = 1; i < cars; i++) {
      const chosen = rivalLiveries[i - 1];
      rivalViews.push(
        chosen
          ? new CarView(scene, { livery: liveryById(chosen.livery), number: chosen.number })
          : new CarView(scene, { body: RIVAL_PAINT[(i - 1) % RIVAL_PAINT.length]! }),
      );
    }
    tagLayer.innerHTML = '';
  };

  const loadStage = (
    stageId: string,
    variantId?: string,
    grid?: { cars: number; slots?: number[]; remote?: number[] },
  ) => {
    stageView?.dispose();
    if (stageView) scene.remove(stageView.group);

    const def = stageById(stageId);
    variant = findVariant(def, variantId);
    stage = new Stage(def);

    // Conditions light the scene, set the fog, and decide how much the
    // headlights matter — which is what finally gives the `lights` component
    // something to do.
    applyConditions(variant.conditions);
    // The colour of the light. Set with the conditions, not with the weather
    // effects: turning the windscreen effect off is asking not to be blinded,
    // not asking for dusk to look like midday.
    visionPass.grade = gradeFor(variant.conditions);
    // And the sound of it: wind, surf, rain and birds, by biome and weather.
    mixer.setPlace(def.biome, variant.conditions);
    precipitation.setWeather(variant.conditions.weather);
    carView.setHeadlightWeight(visibility(variant.conditions).headlightWeight);

    // Damage is on for stages and off for the proving ground: the handling
    // tests and the tuning sweep are measuring the car, not the crashing.
    // Arcade drives a stock car and career drives the one in the garage — the
    // rule itself is in `carFor`, next to the upgrades it is about.
    const car = carFor(mode, career.upgrades);
    world = new SimWorld({
      stage,
      tuning: car.tuning,
      damage: { rollcage: car.rollcage },
      conditions: variant.conditions,
      ...(grid
        ? {
            cars: grid.cars,
            ...(grid.slots ? { slots: grid.slots } : {}),
            ...(grid.remote ? { remote: grid.remote } : {}),
          }
        : {}),
    });
    buildRivalViews(grid?.cars ?? 1);

    // Built after the world, and given the world's own marker poles: what is
    // drawn lying flat has to be exactly what the car knocked over.
    stageView = buildStageView(stage, world.markers!);
    scene.add(stageView.group);
    applyCarCondition();
    race = new Race(stage, variant.medals);
    settled = false;
    terminal = null;
    lights.arm();
    drama.reset();
    crashReplayIn = 0;
    celebrations.clear();
    damagePanel.reset();
    raceHud.setStage(stage, variant.name, variant.medals);
    refreshFinishActions();
    minimap.setStage(stage);
    tuningPanel?.rebind(world.vehicle.tuning);

    camera.applyZones(stage.cameraZones, 0);
    camera.jumpTo(world.state().position);
    stuckFor = 0;
    particles.clear();
    impacts.clear();
    skids.clear();
    vision.reset();

    ghost = null;
    ghostView.visible = false;
    recorder.reset();
    // With the ghost recorder: a restart must not leave the previous run's
    // last two seconds in the reel, or the first crash of the new run replays
    // somebody driving somewhere else.
    crashReel.reset();
    void attachGhost(currentKey());
  };

  /** Seed the world's damage model with the condition the car is actually in. */
  const applyCarCondition = () => {
    // Before the early return, and here rather than at either call site: this
    // is the one line both a stage load and a restart already go through, and
    // a renderer still easing from the *previous* car's damage is exactly the
    // bug this pairing exists to prevent.
    shownDamage.attach(world.damage);
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
    // `?cars=4` fills the grid without a network, so the visual question — do
    // four cars read as four cars, and do the tags land on them — can be
    // answered by the screenshot harness rather than by two browsers.
    const grid = Number(params.get('cars') ?? '1');
    loadStage(
      params.get('stage') ?? STAGES[0]!.id,
      params.get('variant') ?? undefined,
      grid > 1 ? { cars: grid } : undefined,
    );
  }

  // The player's own paint, on the car they drive as well as the one on the
  // turntable. Arcade and multiplayer keep it too: it is who you are, not what
  // you earned.
  carView.setLivery(career.livery, career.raceNumber);

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
      if (mode === 'career' && stage.def.entryFee > 0 && attemptUsed) {
        if (!career.canEnter(currentTarget()).allowed) {
          openGarage();
          return;
        }
        void career.enter(currentTarget());
      }
      world.vehicle.reset(stage.start.position, stage.start.heading);
      race.reset();
      raceHud.setStage(stage, variant?.name, variant?.medals);
      refreshFinishActions();
      raceHud.setBest(save.recordFor(currentKey())?.time ?? null);
      raceHud.setSplitDeltas([]);
      raceHud.setDelta(null);
      recorder.reset();
      crashReel.reset();
      world.damage?.reset();
      world.clearDebris();
      debrisView.clear();
      wildlifeView.clear();
      vision.reset();
      applyCarCondition();
      particles.clear();
      impacts.clear();
      skids.clear();
      settled = false;
      terminal = null;
      lights.arm();
      drama.reset();
      crashReplayIn = 0;
      celebrations.clear();
      raceHud.setLedger(null);
      damagePanel.reset();
      camera.applyZones(stage.cameraZones, 0);
    } else {
      world.vehicle.reset({ x: 0, y: 1.2, z: 0 }, 0);
    }
    camera.jumpTo(world.state().position);
    stuckFor = 0;
  };

  /**
   * Practice aids, and where they stop.
   *
   * A career run you can restart the instant it goes wrong has no consequences
   * in it, which is what the damage model and the economy are for. Arcade
   * banks nothing, so it keeps them; a career only has them while the practice
   * setting is on. The automatic rescue for a genuinely beached car stays
   * either way — that is not an aid, it is the alternative to sitting in a
   * ditch until the timeout.
   */
  const practiceAllowed = () => mode !== 'career' || career.profile.settings.practice;

  controls.onReset = () => {
    if (!practiceAllowed()) {
      damagePanel.notice('No restarts in a career run — finish it or retire.');
      return;
    }
    restart();
  };
  controls.onRescue = () => {
    if (!practiceAllowed()) {
      damagePanel.notice('No rescues in a career run — the car has to get itself out.');
      return;
    }
    world.rescue(race?.furthest);
    stuckFor = 0;
  };
  // The global times board, sharing the room broker's worker and its `?rooms=`
  // override so there is only ever one address to keep in step. Null when there
  // is no broker configured, which the menu and the finish path both handle by
  // simply not showing times.
  const board = boardFor(params);

  const multiplayer = new MultiplayerPanel(hudRoot);
  /*
   * The lobby needs the same first-touch signal the driving controls use: a
   * room code is tapped on a built-in keypad on a phone and typed into a text
   * field on a keyboard machine.
   *
   * Wired here rather than in the `pointerdown` listener near the top of this
   * file, which runs during boot — a touch that landed while the world was
   * still being built would reach a `const` that does not exist yet and throw
   * out of the handler. `TouchControls` already knows when it changes.
   */
  touch.onVisible = (on) => multiplayer.setTouchInput(on);
  multiplayer.setTouchInput(touch.shown);
  multiplayer.board = board;
  // One identity across both modes. Multiplayer races the same stock car as
  // arcade and posts to the same table, so two names for one player would put
  // them on the board twice — which is exactly what one-place-per-driver is
  // there to prevent.
  multiplayer.setName(career.driverName);
  multiplayer.onName = (name) => void career.setDriverName(name);
  multiplayer.onRace = (start) => {
    menu.setOpen(false);
    garage.setOpen(false);
    // A fresh car, the way arcade gets one. Nobody brings their career's wreck
    // to somebody else's race, and nothing that happens in one comes back to
    // the career afterwards — which is also what makes it safe to write off
    // the car completely in a lobby.
    mode = 'arcade';
    sessionHealth = {};
    // Paint and number come from the lobby, so the local car is the one the
    // player picked rather than the one their profile happens to wear.
    const me = start.setup.players.find((player) => player.car === (start.guest?.car ?? 0));
    if (me) carView.setLivery(liveryById(me.livery), me.number);
    // Everyone else, in the grid order this copy of the world uses.
    const mine = start.guest?.car ?? 0;
    rivalLiveries = start.setup.players
      .filter((player) => player.car !== mine)
      .map((player) => ({ livery: player.livery, number: player.number }));
    loadStage(start.setup.stageId, start.setup.variantId, {
      cars: start.cars,
      ...(start.slots ? { slots: start.slots } : {}),
      // On a guest every car but your own is driven from the wire, so they are
      // kinematic. The host simulates all of them for real and marks none.
      ...(start.guest
        ? { remote: Array.from({ length: start.cars - 1 }, (_, i) => i + 1) }
        : {}),
    });

    // Nobody counts down yet. Building a world is asynchronous and takes a
    // different amount of time on every machine, so a countdown armed by
    // `loadStage` put the green up at a different instant on each screen — and
    // the joiner was still on the line while the host was two corners away.
    // The host releases the whole grid once everyone has reported in.
    lights.hold();
    start.onGo?.(() => lights.arm());

    // The host is the authority and starts the clock; a guest hands its world
    // over and is corrected toward the host's from the first snapshot.
    if (start.host) start.host.start(start.setup, world);
    else start.guest!.attach(world);

    // A guest that never reports in cannot hold the grid forever.
    if (start.host) {
      const host = start.host;
      window.setTimeout(() => host.releaseGrid(), 8000);
    }

    // The crash cinematic never runs in a network race: dilating one client's
    // clock desyncs it from the host, and holding *your* screen in slow motion
    // while three other people are still racing is the wrong thing to do to
    // them as well as to you.
    //
    // Switched off at the source rather than checked at each use. There are
    // three consumers — the sim clock, the replay, and the ducked mix — and the
    // third was only ever safe by consequence: `mixer.duck(drama.duck)` is
    // ungated, and returned zero purely because `hit()` happened to be gated
    // upstream. `strength = 0` is the contract `ImpactDrama` documents for
    // exactly this, and it makes the other two belt and braces.
    drama.strength = 0;
    drama.reset();
    crashReplayIn = 0;

    session = new MultiplayerSession(
      { ...(start.host ? { host: start.host } : {}), ...(start.guest ? { guest: start.guest } : {}) },
      {
        world,
        setup: start.setup,
        progressOf: (car) => stage!.progressAt(world.state(car).position).distance,
      },
    );
  };

  const garage = new Garage(hudRoot, career);
  garage.onEnter = (target) => {
    // The fee is taken by the garage; this is the condition the attempt starts
    // from, and the one a restart returns to.
    sessionHealth = { ...career.profile.carHealth };
    // Entering from the garage is a solo run: hang up whatever was connected
    // rather than leaving a race running behind a menu.
    if (session) {
      session.leave();
      session = null;
      multiplayer.reset();
      restoreDrama();
    }
    loadStage(target.def.id, target.variant.id);
  };

  garage.onMenu = () => {
    if (race && race.phase === 'running') void settleRun(true);
    garage.setOpen(false);
    menu.setOpen(true);
  };

  garage.onReset = () => {
    // A fresh career gets a fresh car: the world is holding the old one's
    // damage, and leaving it there would hand the new career a wreck.
    sessionHealth = {};
    if (!freeRoam) loadStage(STAGES[0]!.id);
  };

  const menu = new StartMenu(hudRoot, career);
  menu.board = board;
  menu.onName = (name) => multiplayer.setName(name);
  menu.onCareer = () => {
    rivalLiveries = [];
    mode = 'career';
    sessionHealth = { ...career.profile.carHealth };
    garage.setOpen(true);
  };
  menu.onArcade = (pick) => {
    rivalLiveries = [];
    // A fixed car, every time: arcade never inherits the career's wreck and
    // never hands one back to it.
    mode = 'arcade';
    if (session) {
      session.leave();
      session = null;
      multiplayer.reset();
      restoreDrama();
    }
    sessionHealth = {};
    garage.setOpen(false);
    loadStage(pick.def.id, pick.variant.id);
  };
  /**
   * Is this page running an old build?
   *
   * The one file that can go stale is `index.html`; everything else is
   * content-hashed. See `ui/update.ts` for why this is a poll rather than a
   * cache header — the case it exists for is a phone returning to a tab that
   * has been open for hours, which makes no request at all and so cannot be
   * fixed by anything the server says.
   */
  const updates = new UpdateWatch();
  const updateBanner = new UpdateBanner();
  updates.start();

  // Dropping a connection and going back to the front door are two different
  // things, and only the first happens when the lobby's Back button takes a
  // player from hosting to the choice of hosting or joining — the panel stays
  // open on top of whatever is behind it.
  multiplayer.onDisconnect = () => {
    if (session) {
      session.leave();
      session = null;
    }
    sessionHealth = {};
  };

  // Leaving a lobby goes back to the front door. Without it the only way out of
  // a race you had joined was to reload the page.
  multiplayer.onLeave = () => {
    menu.setOpen(true);
  };

  menu.onMultiplayer = () => {
    garage.setOpen(false);
    // Checked here above anywhere else, because this is where a stale build
    // stops being cosmetic. An older copy has no room field on its join screen
    // at all, so a player given a room code types it into the only box there
    // is and gets told their invite code is unreadable — which is true, and
    // useless. Forced, so the throttle cannot swallow the one check that
    // matters.
    void updates.check(true).then((stale) => {
      if (stale) updateBanner.visible = true;
    });
    multiplayer.setOpen(true);
  };

  const openGarage = () => {
    if (freeRoam) return;
    // Bank whatever happened before leaving, so damage is never lost by walking
    // away from a half-finished run.
    if (race && race.phase === 'running') void settleRun(true);
    garage.setOpen(true);
  };

  /*
   * Browsers refuse to start audio without a gesture, so the graph is built on
   * the first interaction and the game is silent but playable until then.
   *
   * Kept attached until it has actually *worked*, rather than fired once and
   * assumed. `AudioContext.resume()` is a promise, the context can be handed
   * back already suspended, and a gesture the browser does not count leaves it
   * that way — and with `{ once: true }` on each listener there was exactly one
   * attempt and no way back. That is the whole of "the game is silent until I
   * touch the volume control": the volume control calls `start()` again, which
   * is the retry nothing else was doing.
   *
   * `running` is checked on the *next* gesture rather than straight after
   * `start()`, because `resume()` has not resolved by then — so the listeners
   * detach one gesture after audio genuinely comes up, which costs nothing.
   */
  const startAudio = () => {
    if (mixer.running) {
      for (const event of AUDIO_GESTURES) window.removeEventListener(event, startAudio);
      return;
    }
    mixer.start();
  };
  const AUDIO_GESTURES = ['keydown', 'pointerdown', 'pointerup', 'click', 'touchend'] as const;
  for (const event of AUDIO_GESTURES) window.addEventListener(event, startAudio);

  controls.onMute = () => mixer.toggleMute();

  // The volume slider on the front screen. Applied live as it moves and saved
  // when it settles — writing the profile on every pixel of a drag would be a
  // few hundred writes for one adjustment.
  menu.setVolume(career.profile.settings.volume);
  mixer.setVolume(career.profile.settings.volume);
  let volumeSave: number | undefined;
  menu.onVolume = (value) => {
    mixer.setVolume(value);
    window.clearTimeout(volumeSave);
    volumeSave = window.setTimeout(() => {
      void save.update((profile) => {
        profile.settings.volume = value;
      });
    }, 400);
  };

  // The windscreen effect is a taste setting, so it is cycled from the keyboard
  // and remembered: at 0 a night stage is merely dim, at 1 you drive by the
  // headlights alone. The URL parameter still wins, for the visual harness.
  const VISION_STEPS = [0, 0.35, 0.6, 1];
  // The windscreen is a fullscreen pass, which on a phone is pure fill rate —
  // the one thing it has least of. Held at zero on the low tier unless the URL
  // asks for it, which is how the harness photographs it anyway.
  visionPass.strength =
    visionParam !== null
      ? Number(visionParam)
      : quality.vision
        ? career.profile.settings.vision
        : 0;
  // The crash cinematic, on the same pattern and for the same reason: some
  // people will want it off entirely, and 0 means genuinely nothing happens.
  const DRAMA_STEPS = [0, 0.5, 1];
  /**
   * What the player asked for, which in a network race is not what is in
   * effect. `?drama=` outranks the profile, as everywhere else.
   */
  let dramaSetting = dramaParam !== null ? Number(dramaParam) : career.profile.settings.drama;
  drama.strength = dramaSetting;
  /**
   * The cinematic strength this player actually asked for.
   *
   * Kept as a function rather than a value because a network race sets
   * `drama.strength` to 0 and leaving one has to put back whatever the player
   * chose — including a change they made with the K key mid-session, and
   * including `?drama=` which outranks the profile.
   */
  const restoreDrama = () => {
    drama.strength = dramaSetting;
  };

  controls.onDrama = () => {
    const next =
      DRAMA_STEPS[(DRAMA_STEPS.findIndex((v) => v >= dramaSetting - 0.01) + 1) % DRAMA_STEPS.length] ?? 1;
    dramaSetting = next;
    // Remembered but not applied while a network race is running: turning the
    // cinematic on mid-session would put this client's clock back under it and
    // desync it from the host, which is the one thing the gate exists to stop.
    // It takes effect on the way out, in `restoreDrama`.
    if (!session) {
      drama.strength = next;
      if (next === 0) {
        drama.reset();
        // An armed cinematic is part of the effect being turned off.
        crashReplayIn = 0;
      }
    }
    damagePanel.notice(next === 0 ? 'Crash slow-motion off' : `Crash slow-motion ${Math.round(next * 100)}%`);
    void save.update((profile) => {
      profile.settings.drama = next;
    });
  };

  controls.onVision = () => {
    const next =
      VISION_STEPS[(VISION_STEPS.findIndex((v) => v >= visionPass.strength - 0.01) + 1) % VISION_STEPS.length] ??
      0.6;
    visionPass.strength = next;
    damagePanel.notice(`Visibility effect ${Math.round(next * 100)}%`);
    void save.update((profile) => {
      profile.settings.vision = next;
    });
  };

  /**
   * Open photo mode on the run as recorded so far.
   *
   * Mid-run as well as after it: the shot worth taking is usually the one you
   * have just survived, and being made to finish first would lose it.
   */
  controls.onPhoto = () => {
    if (freeRoam || garage.isOpen || menu.isOpen || multiplayer.isOpen) return;
    if (replayUi.active) {
      replayUi.close();
      return;
    }
    if (!stage || !race || recorder.frameCount < 4) return;

    const ghost = recorder.finish(currentKey(), race.time);
    replayUi.open({
      player: new GhostPlayer(ghost),
      time: Math.max(race.time - 3, 0),
      playing: true,
      rate: 0.5,
      yaw: camera.yaw,
      zoom: 12,
    });
    mixer.quiet();
  };

  /**
   * The crash, played back from somewhere you can see it.
   *
   * Slowing the world down was not enough on its own: at a fixed isometric
   * camera a slow crash is a slow crash, and it did not read as the game
   * reacting to anything. This cuts to the last two and a half seconds from an
   * angle three eighths round from the one being driven, close in, at a third
   * speed — and then puts the player back exactly where they were.
   *
   * Never in a network race: the world is paused while it plays, and pausing
   * one client desynchronises it from the host. Never on top of photo mode,
   * which the player opened on purpose.
   */
  const showCrashReplay = () => {
    if (session || replayUi.active || garage.isOpen || menu.isOpen || freeRoam) return;
    if (!stage || !race || race.phase !== 'running' || recorder.frameCount < 8) return;
    // The live value, not the stored one: `?drama=0` and the K key both set
    // this, and the stored setting is only where it starts. Reading the profile
    // meant the harness asked for no cinematic and got one anyway.
    if (drama.strength <= 0) return;

    // The reel, not the ghost. A ghost knows where the car was and nothing
    // else, so a cinematic built from one shows the car already wrecked on the
    // way in and whatever it hit missing entirely.
    const strip = crashReel.take(REPLAY_LEAD + REPLAY_LAG);
    if (!strip) return;
    const ghost = recorder.finish(currentKey(), race.time);
    const player = new GhostPlayer(ghost);
    replayUi.open({
      player,
      reel: strip,
      time: 0,
      playing: true,
      rate: 0.34,
      // Three eighths round, so the impact is seen across the car rather than
      // down the same line it was driven into.
      yaw: camera.yaw + Math.PI * 0.75,
      zoom: 8,
      auto: { label: 'REPLAY', until: strip.duration },
    });
    // Emptied so the cinematic can throw the burst again from the start.
    //
    // What is in there now is the *live* burst, half a second past the frame
    // the replay opens on and a car's length down the road from it — the same
    // class of wrongness as the skid marks and the shed parts, and the reason
    // the reel keeps the impact events at all.
    impacts.clear();

    // Where the race clock has to be put back to: the replay pauses the world,
    // and a crash that gave you two free seconds would be worth having.
    crashReplayFrom = race.time;
    mixer.quiet();
  };

  /** Race time when the crash replay started, so the clock can be made whole. */
  let crashReplayFrom: number | null = null;

  const endCrashReplay = () => {
    replayUi.close();
    // Back to the road as it is. The signs and poles repose themselves on the
    // next live `sync` — the recorded version they were left on is negative and
    // can never match the live counter — but the skid cutoff is a uniform
    // nobody else writes, so it has to be put back here.
    skids.showUpTo(null);
    debrisView.group.visible = true;
    particles.points.visible = true;
    // The world resumes from exactly where it stopped, so nothing is owed —
    // but `settleRun` and the ghost both read `race.time`, and the frame that
    // closes the replay must not hand back a clock that drifted while paused.
    if (crashReplayFrom !== null && race) race.time = crashReplayFrom;
    crashReplayFrom = null;
  };

  replayUi.onExit = () => (replayUi.state?.auto ? endCrashReplay() : replayUi.close());
  replayUi.onCapture = () => {
    // The canvas has to be read in the same tick it was drawn — a WebGL context
    // without `preserveDrawingBuffer` is empty by the next one — so the capture
    // is deferred to the end of the next frame rather than taken here.
    wantsCapture = true;
  };

  controls.onMultiplayer = () => {
    if (freeRoam) return;
    if (garage.isOpen) garage.setOpen(false);
    if (menu.isOpen) menu.setOpen(false);
    multiplayer.toggle();
  };

  /**
   * The finish panel's buttons.
   *
   * Retry is the same path R takes, and it is offered wherever R would work:
   * always in arcade and multiplayer, and in a career only while the practice
   * aids are on — a career run you can repeat for free has no consequences in
   * it. The way out is named for wherever it actually goes.
   */
  // A declaration rather than a const: `loadStage` calls it, and `loadStage`
  // is reachable from the boot path before this point in the file.
  function refreshFinishActions(): void {
    raceHud.setActions({
      retry: mode !== 'career' || career.profile.settings.practice,
      leave: session ? 'Lobby' : mode === 'career' ? 'Garage' : 'Menu',
    });
  }
  raceHud.onRetry = () => {
    touch.release();
    restart();
  };
  raceHud.onLeave = () => {
    touch.release();
    // In a session this is the way out of the finish screen, so it goes to the
    // classification — who won and by how much — rather than resetting the
    // lobby, which would throw that away before it had been read. The lobby's
    // own button is what starts the next race.
    if (session && multiplayer.inLobby) multiplayer.showFinish();
    else controls.onGarage?.();
  };

  // The on-screen menu button does what Escape does, and drops whatever the
  // thumbs were holding on the way — a throttle left down behind a panel is a
  // car that drives itself into the scenery while you read a repair bill.
  touch.onMenu = () => {
    touch.release();
    controls.onGarage?.();
  };

  controls.onGarage = () => {
    if (freeRoam) return;
    // Escape backs out of photo mode before it backs out of anything else.
    if (replayUi.active) {
      replayUi.close();
      return;
    }
    if (menu.isOpen) {
      menu.setOpen(false);
      // Backing out of the menu returns to whatever was already running: the
      // garage in a career, the stage itself in arcade.
      if (mode === 'career' && !session) garage.setOpen(true);
      return;
    }
    // In a career the garage is the place you keep coming back to; Escape goes
    // there, and again from there to the menu. Arcade has no garage, so Escape
    // is the way out to the front door.
    if (mode === 'career' && !garage.isOpen && !session) {
      openGarage();
      return;
    }
    if (race && race.phase === 'running') void settleRun(true);
    garage.setOpen(false);
    menu.setOpen(true);
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

    // Arcade banks nothing locally: no payout, no repair bill, no record, no
    // ghost. The whole point of it is that you can wreck the car on a night
    // stage you have not unlocked and walk away as though it never happened.
    //
    // It is the only mode that publishes, though, and for the reason the car
    // is stock here: every arcade car is the same car, so the times are
    // comparable. A career time is a time set by that player's garage.
    if (mode === 'arcade') {
      session?.report(0, race.finishTime, retired);
      raceHud.setLedger(null);
      const finished = race.finishTime;
      // A retirement is not a lap.
      if (retired || finished === null) return;

      const key = currentKey();
      const label = `${stage.def.name} · ${variant?.name ?? ''}`.replace(/ · $/, '');

      // Personal best first, and locally: it is the one part of this that
      // cannot fail, does not need a network, and is true whether or not the
      // time went anywhere near the board. Arcade and multiplayer share the
      // table because they share the car.
      const personal = await save.submitArcadeRun(key, finished);
      raceHud.setBest(save.arcadeRecordFor(key)?.time ?? null);

      // Then the world. Deliberately not awaited by anything that draws — the
      // panel is already up with the time on it, and the board grows into it a
      // moment later or never.
      void (async () => {
        const posted =
          board && career.driverName
            ? await board.submit(key, career.driverName, finished)
            : null;

        raceHud.markBoard({
          top: posted?.top ?? null,
          rank: posted?.rank ?? null,
          you: career.driverName || 'You',
          yourTime: finished,
          ...(personal ? { beat: personal.beat } : {}),
          // The others, as far as they have got. In multiplayer you reach this
          // panel the moment you cross the line and they are still driving, so
          // this is what is known now — the lobby's classification is the
          // complete one, and it arrives when the last car is in.
          ...(session ? { rivals: multiplayer.standings() } : {}),
        });

        celebrations.show(
          boardAwards({
            name: label,
            time: finished,
            ...(personal ? { beat: personal.beat } : {}),
            ...(posted ? { rank: posted.rank, dethroned: posted.was } : {}),
          }),
        );
      })();
      return;
    }

    const time = race.finishTime;
    const previous = save.recordFor(currentKey())?.time ?? null;

    // Records before the run, so the celebration can say what changed.
    const before = { ...career.profile.records };

    const result = await career.settle(currentTarget(), {
      medal: race.medal,
      time,
      retired,
      damage: world.damage,
      ...(retired || time === null ? {} : { ghost: recorder.finish(currentKey(), time) }),
    });

    // Everyone else wants to know you are done, and the host is the only one
    // who can say so — so a guest sends it up and the host passes it on.
    session?.report(0, time, retired);

    // What it was worth beyond the money: a first gold, a personal best, the
    // last grey stage on the list turning bronze.
    celebrations.show(
      awardsFor({
        keys: career.targets().map((t) => career.keyFor(t)),
        before,
        after: career.profile.records,
        key: currentKey(),
        name: `${stage.def.name} · ${variant?.name ?? ''}`.trim(),
      }),
    );

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
    resize(w, h, renderScale.value);
    camera.resize(w, h);
    visionPass.setSize(w, h);
  };

  /** Screen pixels per world metre under the orthographic camera. */
  const updateParticleScale = () => {
    const scale = window.innerHeight / (2 * camera.effectiveViewSize);
    particles.setScale(scale);
    impacts.setScale(scale);
  };
  window.addEventListener('resize', onResize);
  onResize();

  /**
   * Name tags over the rival cars, in screen space.
   *
   * Projected through the same camera the cars are drawn with, so a tag is
   * exactly over its car whatever a zone's yaw and zoom are.
   */
  const updateTags = () => {
    const names = session?.names ?? [];
    while (tagLayer.children.length < rivalViews.length) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tagLayer.appendChild(tag);
    }
    for (const [i, node] of [...tagLayer.children].entries()) {
      const tag = node as HTMLElement;
      const index = i + 1;
      const car = world.cars[index];
      if (!car || i >= rivalViews.length) {
        tag.style.display = 'none';
        continue;
      }
      const p = car.vehicle.body.translation();
      SCRATCH.set(p.x, p.y + 1.6, p.z).project(camera.camera);
      // Behind the camera, or off the edge: no tag rather than a wrong one.
      const onScreen = Math.abs(SCRATCH.x) < 1.1 && Math.abs(SCRATCH.y) < 1.1 && SCRATCH.z < 1;
      tag.style.display = onScreen ? 'block' : 'none';
      tag.style.left = `${(SCRATCH.x * 0.5 + 0.5) * window.innerWidth}px`;
      tag.style.top = `${(-SCRATCH.y * 0.5 + 0.5) * window.innerHeight}px`;
      tag.style.color = `#${(RIVAL_PAINT[(i % RIVAL_PAINT.length)] ?? 0xffffff).toString(16)}`;
      tag.textContent = names[index] ?? `P${index + 1}`;
    }
  };

  /**
   * The order of the field. Progress along the stage rather than a lap count:
   * it is the same number the host publishes, and it is the meaningful one on a
   * point-to-point stage where nobody laps anybody.
   */
  const updateStandings = () => {
    if (!stage || world.cars.length < 2) return;
    const names = session?.names ?? [];
    raceHud.setStandings(
      world.cars.map((car, index) => ({
        name: index === 0 ? 'You' : (names[index] || `P${index + 1}`),
        progress: stage!.progressAt(car.vehicle.body.translation()).distance,
        you: index === 0,
      })),
    );
  };

  const drawOnce = (alpha: number, dt: number) => {
    const state = world.state();
    const transform = world.renderTransform(alpha);
    // Real seconds: the fold is a duration a person watches, and during a crash
    // the world's clock is the one being slowed down.
    shownDamage.advance(dt);
    carView.update(transform, state, shownDamage, world.debris);
    debrisView.update(world.loose);

    // The other cars, and a name over each. Everything else about them — their
    // damage, their shed panels, their brake glow — is the same code the local
    // car uses, because on this side of the wire they are just cars.
    for (const [i, view] of rivalViews.entries()) {
      const index = i + 1;
      const car = world.cars[index];
      if (!car) continue;
      view.update(
        world.renderTransform(alpha, index),
        world.state(index),
        car.damage,
        car.debris,
      );
    }
    updateTags();
    // Turn the corner boards to face the camera. Cheap — there are a handful —
    // and it is the only way they stay readable through a zone change.
    // Boards still standing turn to face the camera; ones lying in the verge
    // keep whatever attitude the physics left them in.
    if (world.signs) stageView?.signs.sync(world.signs);
    stageView?.signs.faceCamera(camera.yaw);
    if (world.markers && stageView) stageView.markers.sync(world.markers);
    // Saplings that have been knocked over: real bodies, so their instances
    // have to follow them or they go over in the physics and stay standing on
    // screen, which is the worst of both.
    stageView?.props.sync(world.movableProps);
    // The crowd gets out of the way. Driven from the car's drawn position, so
    // people react to where it looks like it is rather than to a fixed step.
    stageView?.crowd.update(dt, transform.position);
    wildlifeView.update(world.wildlife?.animals ?? []);

    if (ghost && race) {
      const sample = ghost.sampleAt(race.time);
      if (sample) ghostView.updateFromGhost(sample);
      // Hide it once its run has ended rather than freezing a car on the road.
      ghostView.visible = race.time <= ghost.duration + 0.5;
    }

    camera.advanceShake(dt);
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

    // Through the windscreen. The cone is anchored to the car *on screen* and
    // aimed along its heading, so it turns with the car rather than with the
    // camera — which is what makes it read as headlights rather than a vignette.
    const visionState = advanceVision(dt);

    const toUv = (p: { x: number; y: number; z: number }) => {
      SCRATCH.set(p.x, p.y, p.z).project(camera.camera);
      return { x: SCRATCH.x * 0.5 + 0.5, y: SCRATCH.y * 0.5 + 0.5 };
    };
    const nose = rotate(transform.rotation, { x: 0, y: 0, z: 12 });
    const origin = toUv(transform.position);
    const ahead = toUv({
      x: transform.position.x + nose.x,
      y: transform.position.y + nose.y,
      z: transform.position.z + nose.z,
    });
    const forwardX = ahead.x - origin.x;
    const forwardY = ahead.y - origin.y;
    const forwardLength = Math.hypot(forwardX, forwardY) || 1;

    visionPass.render(
      scene,
      camera.camera,
      visionState,
      origin,
      { x: forwardX / forwardLength, y: forwardY / forwardLength },
      performance.now() / 1000,
    );
  };

  /**
   * What an impact throws off: sparks, dust and debris, all from one point.
   *
   * Here rather than inside `fx.ts` because this is the layer that knows where
   * the hit landed and what is under the car; the emitters themselves take a
   * point, a colour and a severity and have no opinion about either.
   *
   * Gated by the same `shakenFor` bar that gates the shake and the impact
   * sound, at the call site — `lastImpact` is the hardest contact of the step
   * and not an event, so a car rolling down an embankment would otherwise throw
   * a full burst on every one of the sixty steps it spends in contact.
   */
  const throwCrashFx = (state: VehicleState, severity: number) => {
    if (severity <= 0.02) return;

    // The contact, out of the car's frame and into the world's.
    const offset = rotate(state.rotation, world.lastImpactAt);
    const at = {
      x: state.position.x + offset.x,
      y: state.position.y + offset.y,
      z: state.position.z + offset.z,
    };
    // Outward from the middle of the car, which is the direction anything
    // coming off the contact should go. Normalised from the offset itself: a
    // point on the nose gives a forward normal, one on a flank gives a sideways
    // one, and the degenerate centre hit (a landing) gives straight up.
    const reach = Math.hypot(offset.x, offset.y, offset.z);
    const normal =
      reach > 0.05
        ? { x: offset.x / reach, y: offset.y / reach, z: offset.z / reach }
        : { x: 0, y: 1, z: 0 };

    // What is under the car, for the dust's colour and the debris' floor. The
    // lowest wheel that is actually touching something knows both; airborne,
    // the ground is wherever the car is about to be and the surface is a guess
    // nobody will see, because dust off nothing is not drawn.
    let ground: number | null = null;
    let surface = state.wheels[0]?.surface ?? null;
    for (const wheel of state.wheels) {
      if (!wheel.grounded) continue;
      if (ground === null || wheel.contact.y < ground) {
        ground = wheel.contact.y;
        surface = wheel.surface;
      }
    }

    const hit = {
      at,
      normal,
      velocity: { ...state.velocity },
      ground,
      color: surface?.color ?? 0x8a7a5e,
      severity,
    };
    throwRecordedFx(hit);
    // And kept, so the cinematic can throw it again at the right moment rather
    // than showing the live burst from 1.75 s after the frame on screen.
    crashReel.impact(hit);
  };

  /**
   * Throw one impact's three layers. The only place that emits them.
   *
   * Takes a plain record rather than the world, because it is called from two
   * clocks: live, at the moment of the hit, and again from inside the crash
   * cinematic when the playhead reaches that moment. Feeding it a recording is
   * the whole reason the replay can show the sparks at all.
   */
  const throwRecordedFx = (hit: ReelImpact | Omit<ReelImpact, 't'>) => {
    emitImpactSparks(impacts, hit.at, hit.normal, hit.severity);
    if (hit.ground !== null) {
      BURST_COLOR.setHex(hit.color).offsetHSL(0, 0, 0.1);
      // From the ground under the contact, not from the contact: the dust is
      // the *ground* being kicked up, and a cloud that starts at bumper height
      // hangs in the air like smoke.
      emitImpactBurst(
        impacts,
        { x: hit.at.x, y: hit.ground, z: hit.at.z },
        BURST_COLOR,
        hit.severity,
      );
    }
    emitCrashDebris(
      impacts,
      hit.at,
      hit.velocity,
      // With no ground under it — mid-air, mid-roll — the shards simply fall
      // and fade, which is better than resting on a floor that is not there.
      hit.ground ?? -Infinity,
      hit.severity,
    );
  };

  /**
   * One frame into the crash reel.
   *
   * Wall time, because it is a record of what a person saw and the world's
   * clock is the one being slowed down. Shared with the harness seek loops for
   * the usual reason — they step the world directly and never call `frame()`,
   * and a reel fed only from the frame loop is empty when `?replay=1` asks for
   * a cinematic, so the whole thing was unphotographable and quietly did
   * nothing rather than failing.
   */
  const captureReel = (elapsed: number, alpha: number) => {
    crashReel.capture(
      elapsed,
      world.renderTransform(alpha),
      world.state(),
      // The eased view, not the live model: the reel is a record of what a
      // person saw, and a fold that is halfway in on screen has to be halfway
      // in when the cinematic replays that instant.
      shownDamage,
      world.cars[0]?.debris ?? null,
      world.wildlife?.animals ?? [],
      {
        // The roadside as it stood, so the replay is not drawn against the road
        // the crash left behind.
        skidStamp: skids.stamp,
        signs: world.signs?.all ?? [],
        markers: world.markers?.all ?? [],
      },
    );
  };

  /**
   * Everything a hit does to the *presentation*: the shake, the thud, the FX.
   *
   * One function because there are two paths that drive a car into things and
   * only one of them is the frame loop — the screenshot harness steps the world
   * directly and never calls `frame()`, so an effect written only there produces
   * nothing in any composite and reads as broken when it is merely unreachable.
   * `shoot --cells=crash1.4:quarry-run@26` is the check, and it only works if the
   * seek loop goes through here as well.
   *
   * Returns the severity, or 0 if the hit did not count, so the caller can
   * decide about the cinematic. That is deliberately *not* in here: it pauses
   * the world, which is the one thing a harness seek must never do.
   */
  const reactToImpact = (state: VehicleState, dt: number): number => {
    // The bar the next impact has to clear to count as a new one, decaying over
    // about a second so a second accident is always felt.
    //
    // `lastImpact` is the hardest contact of the step, not an event — a car
    // rolling down an embankment is in contact on every one of them — so
    // without this the mixer is asked for an impact sound sixty times a second
    // while a car grinds along a wall, and the dust never stops going up.
    shakenFor *= Math.pow(0.25, dt);
    if (world.lastImpact <= 1200 || world.lastImpact <= shakenFor * 1.35) return 0;

    const severity = Math.min((world.lastImpact - 1200) / 26_000, 1);
    shakenFor = world.lastImpact;
    camera.shake(severity);
    mixer.impact(severity);
    throwCrashFx(state, severity);
    return severity;
  };

  /**
   * Stand-ins for the live roadside, posed from a recorded frame.
   *
   * Built once and mutated, because the alternative is forty objects a frame
   * for something that runs for a second and a half. Only `fallen` comes from
   * the recording: a position never moves, and `knockedToward` is written once
   * when the thing goes over and never again — so the live value *is* the
   * recorded one.
   *
   * The version is derived from the frame's own timestamp and made negative.
   * Both views skip a `sync` whose version they have already posed, so it has
   * to change with the frame; negative so it can never collide with the live
   * counter, which is what makes the live state repose itself the moment the
   * cinematic ends.
   */
  const recordedSigns: { version: number; all: { fallen: number; knockedToward: number }[] } = {
    version: -2,
    all: [],
  };
  const recordedMarkers: {
    version: number;
    all: { position: Vec3; fallen: number; knockedToward: number }[];
  } = { version: -2, all: [] };

  const poseRecordedRoadside = (frame: ReelFrame, yaw: number) => {
    if (!stageView) return;
    const version = -2 - Math.round(frame.t * 1000);
    const signs = world.signs;
    if (signs) {
      if (recordedSigns.all.length !== signs.all.length) {
        recordedSigns.all = signs.all.map(() => ({ fallen: 0, knockedToward: 0 }));
      }
      for (let i = 0; i < recordedSigns.all.length; i++) {
        const to = recordedSigns.all[i]!;
        to.fallen = frame.signsFallen[i] ?? signs.all[i]!.fallen;
        to.knockedToward = signs.all[i]!.knockedToward;
      }
      recordedSigns.version = version;
      stageView.signs.sync(recordedSigns);
    }
    const markers = world.markers;
    if (markers) {
      if (recordedMarkers.all.length !== markers.all.length) {
        recordedMarkers.all = markers.all.map((marker) => ({
          position: marker.position,
          fallen: 0,
          knockedToward: 0,
        }));
      }
      for (let i = 0; i < recordedMarkers.all.length; i++) {
        const to = recordedMarkers.all[i]!;
        to.fallen = frame.markersFallen[i] ?? markers.all[i]!.fallen;
        to.knockedToward = markers.all[i]!.knockedToward;
      }
      recordedMarkers.version = version;
      stageView.markers.sync(recordedMarkers);
    }
    // After the sync, not before: standing a board back up restores the pose it
    // was built with, which would undo this. The cinematic looks from three
    // eighths round and a board is only readable face-on; live this happens in
    // `drawOnce`, which this path never reaches, so every standing board was
    // edge-on to the replay.
    stageView.signs.faceCamera(yaw);
  };

  /**
   * One frame of a replay — photo mode, or the crash cinematic.
   *
   * Both pose the car from a recording rather than simulating it, so what is on
   * screen is exactly what happened, and they differ in what the recording
   * carries. The cinematic plays a `ReelStrip`: damage, parts, wildlife and the
   * roadside as they were at that instant. Photo mode plays a ghost, which is
   * position and nothing else, so the car wears whatever damage it is carrying
   * now — a small lie, and the right one, because a ghost is saved to disk and
   * compared across sessions and its format has to stay small and stable.
   */
  const drawReplay = (dt: number) => {
    const state = replayUi.state;
    if (!state) return;
    // This path draws with `jumpTo` and never reaches `camera.follow`, which is
    // where the shake used to decay — so the crash cinematic ran with the
    // camera frozen at the amplitude the crash set it to.
    camera.advanceShake(dt);
    // Kept caught up even though the cinematic poses from the reel: the world
    // is still there behind the replay, and the frame that closes it must not
    // start easing a fold that finished two seconds ago.
    shownDamage.advance(dt);
    const was = replayUi.state?.time ?? 0;
    const at = replayUi.advance(dt);
    if (state.reel) {
      /*
       * The sparks, the dust and the debris, thrown again at the moment they
       * belong to.
       *
       * The live burst is 1.75 s ahead of the frame on screen and at a place
       * this camera is no longer pointed at, so the spray field is frozen and
       * hidden for the cinematic and the impact field is emptied and replayed
       * into. It runs on the *replay's* clock rather than the wall's, which is
       * what makes the burst fly apart in slow motion with everything else —
       * and what keeps a three-second shard alive across a playback that takes
       * five seconds of real time to show one and three quarters.
       */
      particles.points.visible = false;
      for (const hit of state.reel.impactsBetween(was, at)) throwRecordedFx(hit);
      impacts.update(dt * state.rate);
      // The crash cinematic: the car as it *was*, with the damage it had at
      // that moment and whatever it was about to hit still standing there.
      const frame = state.reel.at(at);
      carView.updateFromReel(frame, reelDamage.at(frame), reelDebris.at(frame));
      wildlifeView.updateFromReel(frame.animals);
      // And the road it was driving on, as it was then: the marks it had laid
      // by that instant and nothing after them, and the boards and poles that
      // were still standing. Without this the replay of a crash is drawn over
      // the wreckage of that same crash, which is how a car ends up sliding
      // along tracks it has not made yet, past signs it has not hit yet.
      skids.showUpTo(frame.skidStamp);
      poseRecordedRoadside(frame, state.yaw);
      /*
       * And the shed parts, which are the loudest version of the same problem.
       *
       * `world.loose` is the bumper and the bonnet lying in the road *now* —
       * put there by the crash being replayed — and nothing updates it while
       * the cinematic plays, so every one of them sat in shot from the first
       * frame, before the car had touched anything. The reel records whether
       * each part is on the car, which is what the replay needs; where a part
       * that has left it flew to is not recorded and not worth recording, so
       * the honest picture is no loose part at all.
       */
      debrisView.group.visible = false;
      camera.setYaw(state.yaw);
      camera.setViewSize(state.zoom);
      camera.jumpTo(frame.position);
    } else {
      impacts.update(dt);
      const sample = state.player.sampleAt(at);
      if (sample) {
        carView.updateFromGhost(sample);
        // Photo mode poses from a ghost, which carries none of this — the road
        // it shows is simply the road as it is.
        skids.showUpTo(null);
        camera.setYaw(state.yaw);
        camera.setViewSize(state.zoom);
        camera.jumpTo(sample.position);
      }
    }
    ghostView.visible = false;

    const sun = keyLightOffset(camera.yaw);
    key.position.set(
      camera.focus.x + sun.x,
      camera.focus.y + sun.y,
      camera.focus.z + sun.z,
    );
    key.target.position.copy(key.position).sub(new THREE.Vector3(sun.x, sun.y, sun.z));
    key.target.updateMatrixWorld();

    // The spray is frozen for the cinematic, not advanced and hidden: hiding it
    // alone would age five real seconds of gravel while the world was paused,
    // and the road would come back out of the replay with nothing on it. Photo
    // mode is the other case and has always run it.
    if (!state.reel) particles.update(dt);
    updateParticleScale();
    visionPass.render(
      scene,
      camera.camera,
      vision.update(0, {
        conditions: world.conditions,
        speed: 0,
        surface: 'tarmac',
        wiperHealth: 1,
          windscreenHealth: 1,
        lightHealth: world.damage?.get('lights') ?? 1,
      }),
      { x: 0.5, y: 0.5 },
      { x: 0, y: 1 },
      performance.now() / 1000,
    );
    if (wantsCapture) {
      wantsCapture = false;
      savePicture();
    }
  };

  /** Write the canvas out as a PNG the browser downloads. */
  const savePicture = () => {
    try {
      const link = document.createElement('a');
      link.download = `rsc-${stage?.def.id ?? 'shot'}-${Date.now()}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      damagePanel.notice('Picture saved');
    } catch {
      damagePanel.notice('The browser would not let go of the picture');
    }
  };

  /**
   * Anything scraping along the road throws sparks from where it touches, and
   * leaves a gouge behind it.
   *
   * The mark is the part that lasts: sparks are gone in a tenth of a second,
   * and a torn strip of road under the corner you dragged through is still
   * there on the next lap.
   *
   * Shared with the screenshot harness rather than living inside the frame
   * loop, because the harness steps the world directly — written into `frame`
   * it produced nothing in any screenshot, which is exactly the sort of thing
   * that gets called broken when it is only unreachable.
   */
  const dragEffects = (dt: number): void => {
    const state = world.state();
    const dragging = world.debris?.dragging() ?? [];
    for (let slot = 0; slot < 2; slot++) {
      const id = dragging[slot];
      const at = id ? carView.dragPoint(id) : null;
      if (!at) {
        // Or the next mark bridges the gap back to wherever it last scraped.
        skids.lift(4 + slot);
        continue;
      }
      emitDragSparks(particles, at, state.velocity, Math.abs(state.speed), dt);
      // Across the direction of travel, which is the way a scraped stripe lies.
      const speed = Math.hypot(state.velocity.x, state.velocity.z);
      const side =
        speed > 0.5
          ? { x: -state.velocity.z / speed, y: 0, z: state.velocity.x / speed }
          : { x: 1, y: 0, z: 0 };
      skids.lay(
        4 + slot,
        // A hair above where the part is touching: the mark is a decal on the
        // road, and laid at the exact contact height it sinks into it.
        { x: at.x, y: at.y + 0.02, z: at.z },
        side,
        0.24,
        Math.min(Math.abs(state.speed) / 8, 1),
        SCRAPE_COLOR,
      );
    }
  };

  window.RSC = {
    ready: true,
    rendered: false,
    seekStage(stageId, seconds, crashFor = 0, grip = 0.6) {
      // The AI, the validator and the harness all drive from a standstill and
      // none of them should sit through a countdown.
      lights.skip();
      // Reuse the loaded stage when possible: reloading would drop the ghost
      // that seedGhostAndSeek has just attached.
      if (!stage || stage.def.id !== stageId) loadStage(stageId);
      else restart();
      const driver = new Driver(stage!, { gripBudget: grip, tuning: world.vehicle.tuning });
      for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
      world.time = 0;
      while (world.time < seconds) {
        world.step(driver.input(world.state(), world.dt));
        race!.update(world.state(), world.dt);
        // Accumulate spray and marks so a harness frame shows the same effects
        // a player would see, rather than a suspiciously clean road.
        updateWheelEffects(particles, skids, world.state().wheels, world.state().velocity, world.dt);
        reactToImpact(world.state(), world.dt);
        shownDamage.advance(world.dt);
        captureReel(world.dt, 1);
        carView.update(world.renderTransform(1), world.state(), shownDamage, world.debris);
        dragEffects(world.dt);
        particles.update(world.dt);
        impacts.update(world.dt);
        advanceVision(world.dt);
        // The crowd scatters as the car arrives, and a screenshot taken at the
        // end of a seek should show a scattered crowd rather than a tidy one.
        stageView?.crowd.update(world.dt, world.state().position);
        // And the run is recorded, the way a player's is — the crash replay
        // plays back the ghost recording, so without this there is nothing for
        // the harness to photograph.
        if (race!.phase === 'running') recorder.capture(race!.time, race!.furthest, world.state());
      }
      if (crashFor > 0) {
        const until = world.time + crashFor;
        while (world.time < until) {
          world.step({ throttle: 1, brake: 0, steer: 1, handbrake: 0 });
          race!.update(world.state(), world.dt);
          updateWheelEffects(particles, skids, world.state().wheels, world.state().velocity, world.dt);
          // The whole point of a `crash:` cell is the sparks, the dust and the
          // debris, so this loop above all others has to go through the shared
          // reaction rather than merely bending the car.
          reactToImpact(world.state(), world.dt);
          shownDamage.advance(world.dt);
          captureReel(world.dt, 1);
          particles.update(world.dt);
          impacts.update(world.dt);
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
      updateStandings();
      raceHud.setNotes(cornersAhead(stage!.corners, race!.furthest, 2));
      // `?replay=1` opens the crash replay on whatever has just happened. It is
      // otherwise only reachable by crashing hard enough, in a real browser, at
      // the right moment, which is not a thing a screenshot can wait for.
      if (params.has('replay')) showCrashReplay();
      minimap.update(world.state().position, race!.progress);
      damagePanel.update(world.damage!);
      hud.update(world.state(), 60);
    },
    async seedGhostAndSeek(stageId, seconds) {
      lights.skip();
      if (!stage || stage.def.id !== stageId) loadStage(stageId);
      const driver = new Driver(stage!, { tuning: world.vehicle.tuning });
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
      lights.skip();
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
      // A cinematic is drawn by the path that draws cinematics. `draw` used to
      // call `drawOnce` unconditionally, so `?replay=1` opened the replay,
      // photographed the live scene behind it, and looked for all the world
      // like the replay simply rendered the present.
      if (replayUi.active) drawReplay(1 / 60);
      else drawOnce(1, 1 / 60);
      window.RSC!.rendered = true;
    },
    async finishWithAi(timeout = 240) {
      lights.skip();
      if (!stage || !race) return { error: 'no stage loaded' };
      const driver = new Driver(stage, { tuning: world.vehicle.tuning });
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
        // Whether the start lights still have the car. A test that waits for
        // the green lamp on screen is waiting for something that shows for a
        // second and a half; on a page rendering one frame a second that is a
        // coin toss, and the car gets driven against the handbrake.
        held: lights.holding,
        // The steering the car is actually being given. On a phone this is the
        // only way to tell a thumb that moved from a thumb the page swallowed.
        steer: lastInput.steer,
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
        // Multiplayer, for the two-page check: how many cars are in this
        // world, where they are, and who this machine thinks it is talking to.
        skidQuads: skids.laid,
        // What the crash is throwing, and whether the cinematic is up. Both are
        // otherwise only answerable by looking, and "I cannot see the sparks"
        // is exactly the report that needs a number rather than an opinion.
        crashFx: impacts.alive,
        crashShards: impacts.survivors(2),
        replay: replayUi.state?.auto ? 'crash' : replayUi.active ? 'photo' : null,
        dents: (world.damage?.dents.length ?? 0) + '/' + (career.profile.carDents?.length ?? 0),
        markersDown: world.markers?.flattened ?? 0,
        recorded: recorder.frameCount,
        cars: world.cars.length,
        // Simulated seconds and fixed steps: the first thing to check when a
        // car is not moving is whether the world is running at all.
        worldTime: +world.time.toFixed(2),
        steps: world.steps,
        // Ground position per car, x and z. Not z alone: a stage's start
        // heading is whatever the road does, so a car driving hard down the
        // road can barely change its z at all.
        carsAt: world.cars.map((car) => {
          const p = car.vehicle.body.translation();
          return [+p.x.toFixed(2), +p.z.toFixed(2)];
        }),
        net: session
          ? {
              role: session.role,
              players: session.names,
              connected: session.connected,
              ping: session.ping,
              quality: session.netQuality,
            }
          : null,
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

    // `?glass=0.4` sets the windscreen to that health directly. The three
    // stages the cracks are authored against — a chipped edge, a couple of
    // stars, a web — are a third of a component's range apart, and `?wreck=`
    // cannot aim at one: it puts impulses through the nose and the flanks and
    // whatever the windscreen catches from that is whatever it catches.
    const glass = params.get('glass');
    if (glass && world!.damage) {
      world!.damage.health.set('windscreen', Math.max(0, Math.min(1, Number(glass))));
      world!.damage.refreshFailures();
      damagePanel.update(world!.damage);
    }

    const loosen = params.get('loosen');
    if (loosen) {
      world!.debris?.applyImpact({ x: 0, y: 0, z: 1.9 }, Number(loosen));
      const state = () => world!.state();
      for (let i = 0; i < 120 * Number(params.get('after') ?? '2'); i++) {
        world!.step({ throttle: 0.35, brake: 0, steer: 0, handbrake: 0 });
        updateWheelEffects(particles, skids, state().wheels, state().velocity, world!.dt);
        // Pose the car before reading where the dragging part touches: sparks
        // and the scrape both come off its world position, and an unposed view
        // reports where the bumper was before it started hanging.
        carView.update(world!.renderTransform(1), state(), world!.damage, world!.debris);
        dragEffects(world!.dt);
        particles.update(world!.dt);
        impacts.update(world!.dt);
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

    // `?boil=0.95` puts the coolant where it would be after a long stint with a
    // holed radiator, then runs on so the plume builds. Steam is the only
    // warning an overheat gives, and the only way to check that it reads as
    // steam is to look at one.
    const boil = params.get('boil');
    if (boil && world!.damage) {
      world!.damage.temperature = Number(boil);
      const state = () => world!.state();
      for (let i = 0; i < 120 * 2; i++) {
        world!.step({ throttle: 0.3, brake: 0, steer: 0, handbrake: 0 });
        world!.damage.temperature = Number(boil);
        const t = world!.renderTransform(1);
        const vent = rotate(t.rotation, { x: 0, y: 0.55, z: 1.15 });
        emitSteam(
          particles,
          { x: t.position.x + vent.x, y: t.position.y + vent.y, z: t.position.z + vent.z },
          state().velocity,
          world!.damage.boiling,
          world!.dt,
        );
        particles.update(world!.dt);
        impacts.update(world!.dt);
      }
      camera.jumpTo(world!.state().position);
    }

    // `?knock=6` lays down the six marker poles nearest the car. Clipping one
    // for real needs the AI to run wide at exactly the right place, and the
    // question here — does a fallen pole read as a fallen pole — deserves a
    // cheaper answer than that.
    const knock = params.get('knock');
    if (knock && world!.markers) {
      const here = world!.state().position;
      const nearest = [...world!.markers.all].sort(
        (a, b) =>
          Math.hypot(a.position.x - here.x, a.position.z - here.z) -
          Math.hypot(b.position.x - here.x, b.position.z - here.z),
      );
      for (const marker of nearest.slice(0, Number(knock))) {
        marker.fallen = 1;
        marker.knockedToward = Math.random() * Math.PI * 2;
      }
      world!.markers.version++;
    }

    // `?lights=2` lights two reds on the gantry, `?lights=go` the green. The
    // countdown is over in four seconds and a screenshot of it is otherwise a
    // race against the harness.
    const lamps = params.get('lights');
    if (lamps) {
      const go = lamps === 'go';
      const reds = go ? 3 : Number(lamps);
      // Cast because the assignment happens inside `loadStage`, which the
      // compiler cannot see from here.
      (stageView as StageView | null)?.startLights.set(reds, go);
      raceHud.setLights(reds, go);
    }

    // `?award=gold` puts a celebration on screen. Earning one for a screenshot
    // means driving a stage well enough to deserve it, which is a slow way to
    // check that a word is centred.
    const award = params.get('award');
    if (award) {
      const kinds: Record<string, { title: string; detail: string; weight: number; medal: string | null }> = {
        record: { title: 'NEW RECORD', detail: '41.80s — 1.60s faster', weight: 2, medal: null },
        gold: { title: 'GOLD', detail: 'Pine Loop · Day', weight: 2, medal: 'gold' },
        sweep: { title: 'ALL GOLD', detail: '15 stages, every one of them', weight: 3, medal: 'gold' },
      };
      const chosen = kinds[award] ?? kinds.gold!;
      celebrations.show([
        {
          kind: award === 'record' ? 'record' : award === 'sweep' ? 'sweep' : 'medal',
          title: chosen.title,
          detail: chosen.detail,
          weight: chosen.weight,
          medal: chosen.medal as never,
        },
      ]);
      celebrations.update(0);
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
    const dents = model.dents.map((dent) => ({ ...dent, at: { ...dent.at } }));
    await save.update((profile) => {
      profile.carHealth = health;
      profile.carDents = dents;
    });
  }

  // Start at the front door. The game used to open in the garage, which made
  // the first question it asked "which stage will you spend money on" — a fine
  // second question and a strange first one.
  //
  // `?stage=` is the exception: an explicit stage in the URL is either the
  // harness or somebody who has already chosen, so it drives straight there.
  if (!freeRoam) {
    // `?screen=garage` and `?screen=arcade` open one screen directly, which is
    // how the visual harness photographs them.
    const screen = params.get('screen');
    // `?join=CODE` is an invite link, and it beats every other opening screen:
    // somebody sent it, and the only reason the page is open is to use it.
    const joinCode = params.get('join');
    if (joinCode) multiplayer.joinFromLink(joinCode);
    const roomCode = params.get('room');
    if (roomCode) multiplayer.joinRoomFromLink(roomCode);
    else if (screen === 'garage') garage.setOpen(true);
    else if (screen === 'arcade') menu.setOpen(true, 'arcade');
    else if (screen === 'lobby') {
      // Straight into a hosted lobby, so the harness can photograph the grid,
      // the paint picker and the tally without two browsers and a handshake.
      multiplayer.setOpen(true);
      multiplayer.demo();
    } else if (screen === 'results') {
      // The classification, which is otherwise only reachable by getting a
      // whole grid to the end of a stage together.
      multiplayer.setOpen(true);
      multiplayer.demoResults();
    }
    else if (params.has('stage')) garage.setOpen(false);
    else menu.setOpen(true);
  }

  let last = performance.now();
  let fps = 60;

  const frame = (now: number) => {
    // Two clocks. `dt` is capped so a stall cannot hand the physics accumulator
    // a second of time to catch up on in one frame; `wallDt` is the real one,
    // for anything a player experiences as a duration. The start countdown ran
    // on the capped clock, so on a machine managing a few frames a second the
    // four-second countdown took the best part of a minute — and the automated
    // browser checks, which run through software WebGL, sat through all of it.
    const wallDt = Math.min((now - last) / 1000, 0.5);
    const dt = Math.min(wallDt, 0.1);
    last = now;

    // Trade resolution for frame rate. Fill rate is the first thing a phone
    // runs out of, and it is the only setting that can be changed mid-race
    // without rebuilding anything — so it is the one that adapts.
    if (renderScale.update(wallDt)) onResize();
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.08;

    if (replayUi.active) {
      drawReplay(dt);
      // An automatic replay closes itself; photo mode waits for the player.
      if (replayUi.finished) endCrashReplay();
      requestAnimationFrame(frame);
      return;
    }

    /*
     * Nothing behind a full-screen panel is worth simulating or drawing.
     *
     * The menu, the garage and the lobby all cover the whole window at 96–97%
     * opacity, and the world went on being stepped at 120 Hz and rendered
     * behind them — a stage step with damage costs 156–344 µs, so that is 19–41
     * ms of CPU per second of *nothing anybody can see*, plus the whole 3D
     * scene, plus the tyres laying skid marks on a car nobody is driving. On a
     * phone that is heat and battery for no picture at all, and it is why the
     * menus felt sticky.
     *
     * Two things are deliberately not part of the test. A network race steps
     * whatever is on screen, because the host is authoritative and a client
     * that stops stepping desynchronises from it. And a race that is genuinely
     * running is never frozen: every path that opens one of these panels settles
     * the run first, so this only ever means "no race in progress" — but it is
     * checked rather than assumed, because `settleRun` is asynchronous and there
     * are a couple of frames where both are true.
     *
     * The garage keeps its car: it has its own renderer and its own loop, and
     * has never had anything to do with this one.
     */
    const covered = menu.isOpen || garage.isOpen || multiplayer.isOpen;
    if (covered && !session && race?.phase !== 'running') {
      // Or the engine note hangs on the last frame before the panel opened.
      mixer.quiet();
      requestAnimationFrame(frame);
      return;
    }

    // The start. While the lamps are lit the car is held on the line: the
    // handbrake is on and nothing the player does reaches the wheels.
    const driving =
      garage.isOpen || multiplayer.isOpen || menu.isOpen
        ? NEUTRAL_INPUT
        : touch.merge(controls.sample(dt), wallDt);
    const lit = lights.update(wallDt, driving.throttle);
    if (lit) mixer.startLight(lit === 'go');
    stageView?.startLights.set(lights.lamps, lights.greenFor > 0);
    raceHud.setLights(lights.holding ? lights.lamps : 0, lights.greenFor > 0, lights.launch);

    const held = lights.holding && race !== null;
    const input = held
      ? // The throttle still reaches the engine while the car is held: the revs
        // are what there is to time, and a countdown you can only watch is a
        // countdown with no decision in it. The handbrake holds the car.
        { ...NEUTRAL_INPUT, throttle: driving.throttle, handbrake: 1 }
      : // A launch fluffed by sitting on the limiter through the whole
        // countdown does not hook up. This is the only place the start can
        // cost you anything, and it is what makes timing the light worth more
        // than holding the pedal down.
        { ...driving, throttle: driving.throttle * lights.throttleScale };
    lastInput = input;
    // The crash cinematic runs on the clock the world sees, not on the frame
    // clock: the accumulator is simply fed less real time, so the fixed 120 Hz
    // step, the physics and the netcode are all untouched. Never in a network
    // race — slowing one client's world desyncs it from the host — and never
    // while `drama.strength` is 0, where `timeScale` is exactly 1.
    drama.update(dt);
    mixer.duck(drama.duck);
    // Colour drains and the corners close in for exactly as long as the world
    // is slow. One number, so `?drama=0`, the K key and a network race all
    // switch it off without knowing it exists.
    visionPass.impact = drama.duck;
    const simDt = session ? dt : dt * drama.timeScale;

    // Let the crash finish happening before cutting to the replay of it.
    //
    // Wall time, because this is a wait a person sits through and the world is
    // in slow motion for the whole of it — measured on the sim clock it would
    // be three times as long. `showCrashReplay` takes its strip when this
    // fires, so the strip ends here too: everything the impact caused is
    // inside the recording rather than after the end of it.
    if (crashReplayIn > 0) {
      crashReplayIn -= wallDt;
      if (crashReplayIn <= 0) {
        crashReplayIn = 0;
        showCrashReplay();
      }
    }

    // In a network race every fixed step goes through the host or the guest:
    // that is what puts inputs on the wire and takes snapshots off it.
    const alpha = session ? session.advance(dt, input) : world.advance(simDt, input);

    const state = world.state();
    if (race && stage) {
      const wasRunning = race.phase === 'running';
      const splitsBefore = race.splits.length;
      // The race clock is the world's clock. Left on real time, every big crash
      // would quietly add half a second to the run.
      race.update(state, simDt);

      // A bump the car shrugs off should still be felt and heard, so this reads
      // the raw impulse rather than waiting for a damage event.
      if (reactToImpact(state, dt) > 0) {
        // Only a hit worth watching gets the cinematic; `hit` decides, and
        // returns false for everything below its own threshold. Armed rather
        // than shown: see `crashReplayIn`.
        if (!session && drama.hit(world.lastImpact)) crashReplayIn = REPLAY_LAG;
      }

      // What happened first, then what it broke.
      for (const notice of world.drainNotices()) damagePanel.notice(notice);

      // Surface what just broke while the impact is still on screen.
      if (world.damage) {
        damagePanel.report(world.damage.drainEvents());
        damagePanel.update(world.damage);

        // A terminal failure stops the engine; it does not stop the race. The
        // run ends when the car does — or does not end at all, if the car
        // rolls over the line first.
        const failure = [...world.damage.failures][0];
        if (failure && race.phase === 'running' && !terminal) {
          terminal = { label: FAILURE_LABEL[failure], stopped: 0 };
          damagePanel.notice(`${FAILURE_LABEL[failure]} — coasting, brake to stop`);
        }
      }

      if (terminal && race.phase === 'running') {
        terminal.stopped = Math.abs(state.speed) < 0.8 ? terminal.stopped + dt : 0;
        // Half a second of genuinely stopped, so a car pausing against a rock
        // on its way down a hill is not called a retirement.
        if (terminal.stopped > 0.5) race.retire(terminal.label);
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
        // A multiplayer race ends back in the lobby rather than in the garage:
        // the shape of an evening is race, look at the tally, pick a different
        // stage, go again, and being dropped into the garage ends it instead.
        //
        // But not *yet*. The lobby panel used to open the instant the line was
        // crossed, which covered the finish screen before it could be read —
        // your time, the three fastest, and who else is still out there — and
        // that is the whole reward for the lap. The race panel stays up and its
        // leave button already says "Lobby"; going there is a press now.
      }

      raceHud.update(race);
      // The order of the field. Progress along the stage rather than a lap
      // count: it is the same number the standings the host publishes use, and
      // it is meaningful on a point-to-point stage where nobody laps anybody.
      updateStandings();
      // The co-driver's call and the minimap both read the corner list and the
      // progress the race is already tracking.
      if (stage) {
        raceHud.setNotes(cornersAhead(stage.corners, race.furthest, 2));
        minimap.update(state.position, race.progress);
      }

      // Beaching the chassis across the verge with all four wheels dangling is
      // unrecoverable by driving, so the game recovers for you.
      // A car with a dead engine is not stuck, it is finished coasting, and
      // putting it back on the road would be putting a corpse on the road.
      if (race.phase === 'running' && !terminal && Math.abs(state.speed) < 1) {
        stuckFor += dt;
        if (stuckFor > AUTO_RESCUE_AFTER) {
          world.rescue(race.furthest);
          stuckFor = 0;
        }
      } else {
        stuckFor = 0;
      }
    }

    // The crash reel: what the last couple of seconds looked like, so the
    // cinematic can replay them rather than re-stage them.
    if (!garage.isOpen && !session && race?.phase === 'running') {
      captureReel(wallDt, alpha);
    }

    // Spray, marks and sound all read straight off tyre saturation — the same
    // number the physics uses — so what you see and hear is what is happening.
    if (!garage.isOpen) {
      updateWheelEffects(particles, skids, state.wheels, state.velocity, dt);
      // Steam from a boiling radiator, out of the bonnet vents.
      const boiling = world.damage?.boiling ?? 0;
      if (boiling > 0) {
        const t = world.renderTransform(1);
        const vent = rotate(t.rotation, { x: 0, y: 0.55, z: 1.15 });
        emitSteam(
          particles,
          { x: t.position.x + vent.x, y: t.position.y + vent.y, z: t.position.z + vent.z },
          state.velocity,
          boiling,
          dt,
        );
      }

      dragEffects(dt);
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
    impacts.update(dt);
    updateParticleScale();
    precipitation.update(dt, camera.focus, window.innerHeight / (2 * camera.effectiveViewSize));

    celebrations.update(dt);
    // Not while somebody is driving: a bar across the screen mid-corner is a
    // worse bug than the one it is reporting. Set every frame rather than on an
    // event, because it has to go up when the race *ends* as well as when the
    // update is first noticed, and the banner ignores a value it already has.
    updateBanner.visible = updates.stale && race?.phase !== 'running';
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
