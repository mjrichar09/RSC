# RSC — working notes

A top-down/isometric rally racer. `README.md` says what the game is and why it
is built the way it is. **This file is the operating manual**: the rules that
cannot be broken, where everything lives, how to check a change cheaply, and the
holes already fallen into.

It is loaded into every session, so it earns its length or it gets cut.

## Non-negotiables

1. **`src/sim/` must never import three.js.** The whole simulation runs in Node,
   which is what makes `npm test`, `telemetry`, `sweep`, `stages`, `perf` and the
   stage generator possible. `src/render/` may import from `sim/`; never the
   reverse. Rendering reads simulation state and never writes it.
2. **No `Math.random` in `sim/` or `game/`** — not even as a `?? Math.random`
   default. Headless runs must be reproducible; randomness comes from a seeded
   stream, and the fallback has to be seeded too.
3. **No `process.env` anywhere under `src/`.** Undefined in the browser, and it
   throws where you will not see it.
4. **Every magic number for the car lives in `src/data/tuning.ts`.** Nothing else
   carries one.
5. **Anything drawn at the size of a thing you can hit belongs in `sim/`.** If
   the player can see it and the simulation does not know about it, the car will
   drive through it.
6. **`npm test` is the gate for every change.** After touching stage data,
   vehicle physics or anything that moves a gate, `npm run stages` as well — it
   is the only thing that reports a stage that stopped being completable.

## Architecture map

### Layers

```
data/   numbers and stage definitions        (imports types from sim/)
  │
  ▼
sim/    physics, vehicle, tires, stage, scenery, AI, telemetry   ← no three.js
  │                                                                no DOM
  ├──────────────┬───────────────┬──────────────┐                  no randomness
  ▼              ▼               ▼              ▼
game/         net/            render/        audio/
race rules    the wire        three.js       synthesis
career        host/guest      reads sim      reads sim
economy       protocol        never writes
  │              │               │              │
  └──────────────┴───────┬───────┴──────────────┘
                         ▼
                       ui/        DOM overlay: HUD, garage, menus, lobby, maps
                         ▼
                     main.ts      the only place any of it is wired together

tools/   Node harnesses. Import sim/, game/, data/ — never render/ or ui/.
         The three that need pixels (shoot, uicheck, netcheck) drive a real
         browser through Playwright instead of importing anything from it.
```

Two edges the diagram cannot draw: `game/` reaches sideways into `net/` for the
multiplayer session, and `data/` and `sim/` import each other — `data/` takes
types from `sim/`, `sim/` takes numbers from `data/tuning.ts`.

One upward import exists and is deliberate: `sim/runStage.ts` uses
`game/race.js`, because it is a harness that drives a whole stage rather than a
part of the simulation. Nothing else in `sim/` may reach up.

### One frame

```
ui/controls (keyboard, gamepad)
      ↓ DriverInput
SimWorld.step()  ×N     fixed 120 Hz, accumulator, capped at 0.1 s of catch-up
      ↓ VehicleState
Race.update()           clock, gate planes, splits, medals
      ↓
render/* + ui/*         interpolate between the last two steps; read only
```

The sim clock and the wall clock are different things. `dt` is the world's;
`wallDt` is the one a person experiences. Countdowns and animations use
`wallDt` — see the trap below.

### Where to change what

| Question | File |
|---|---|
| How the car behaves | `sim/vehicle.ts`, `sim/tires.ts`, numbers in `data/tuning.ts` |
| What breaks in a crash, and the bill | `sim/damage.ts`, `sim/debris.ts` |
| The shape of a stage | `data/stages/`, `sim/spline.ts`, `sim/terrain.ts` |
| The corridor cross-section | `sim/corridor.ts` — road, verge, bank, wall, all of it |
| Trees, boulders, houses: where they stand and what is solid | `sim/scenery.ts` |
| The height of the open ground away from the road | `sim/terrain.ts` — `groundHeight` |
| Hazards on the verge, gates, corner signs, bridge piers | `sim/stage.ts` |
| Colliders, contacts, the fixed loop | `sim/world.ts` |
| The AI's line and pace | `sim/driver.ts` |
| Timing, checkpoints, medals | `game/race.ts` |
| Money, upgrades, saved progress | `game/economy.ts`, `game/garage.ts`, `game/save.ts` |
| What anything looks like | `render/stageMesh.ts`, `render/carView.ts`, `render/fx.ts` |
| Lighting and weather look | `render/scene.ts`, `render/grade.ts` |
| HUD, garage, menus, lobby | `src/ui/` |
| Maps and elevation | `ui/stageMap.ts` |
| Multiplayer | `src/net/` (wire), `game/multiplayer.ts` (session) |

Every source file opens with a comment saying what it is for and, where it
matters, what was tried first and why it failed. Read that block before the
code; it is usually the answer.

Which makes a wrong comment worse than no comment: it is the documentation, so
correct one in place the moment it is found rather than noting it and moving on.
Verify before rewriting, though — a comment that reads backwards is often right.
`tireGripBalance` says ">1 gives the front more bite (more oversteer)" and looks
wrong beside a `sweep` that calls the car "understeer" at that value; both are
true, because the chassis understeers on its own and the number dials it out.
The fix there was to add the measurement, not to change the claim.

### Two entry points

- **Browser:** `src/main.ts`. Query parameters drive the visual harness —
  `?stage=&t=` boots straight into a stage at a given time, `?free` opens the
  proving ground, `?drama=0` disables the crash cinematic. `tools/shoot.ts`
  documents the full set it uses.
- **Node:** `tools/*.ts`, all of which build a `SimWorld` directly. They never
  call `frame()`, so anything that only lives inside the frame loop is invisible
  to them — put per-frame effects in a function both paths call.

## Verify with numbers before pictures

The cheap checks come first, and most questions never need an image:

```bash
npm test           # the default gate for every change
npm run telemetry  # handling questions, in text
npm run sweep      # balance: lateral g, turn radius, front-minus-rear slip
npm run stages     # is every stage still completable, and how fast
npm run crash      # what an impact at a given speed breaks and costs
npm run telemetry -- --trace=stops --damage   # brake temperature
npm run telemetry -- --trace=drift            # can it be held sideways, and swapped
npm run crash -- --drop=1,3,5 --pitch=0.35    # what a landing costs
npm run crash -- --balance=45,66              # can it sit on two wheels?
npm run crash -- --deer=60,90,120             # what a deer strike costs
npm run perf       # simulation cost per step
npm run shoot      # ONE composite grid PNG, only for visual questions
npm run netcheck   # two browsers, one race — the only test of the real transport
npm run uicheck    # career, arcade and multiplayer all open from the menu
npm run mobilecheck # a phone viewport, driven by thumbs rather than by keys
```

`shoot` always emits a single labelled grid rather than a burst of images, and
prints the game's own status JSON beside each frame. Reach for it when the
question is genuinely "does this look right", not before. It needs `shots/` to
exist and will not create it.

`telemetry`, `sweep` and `stages` all take `--set=key=value,...` to try tuning
values without editing and reverting a file. `stages` only gained it after the
documentation had claimed it for months — every "the AI still gets round with
the new handling" check before that was driving the committed tuning and
reporting the committed times.

**A fixed-input trace cannot A/B a number the inputs are expressed in.** The
`catch` trace steers at `0.85`, which is a *fraction of lock* — so raising
`maxSteerAngle` raises the counter-steer it applies and the trace measures a
different manoeuvre rather than a different car. It is an honest instrument for
`peakSlipAngle` (0.20 → 0.24 moved held slide from 3.16 s to 3.47 s) and a
useless one for steering lock, where only the closed-loop `drift` trace and the
minimum radius out of `sweep` say anything.

Handling questions that are about *feel* need a closed-loop trace, not a
recording. With fixed inputs, changing the tuning changes what the trace is
testing: the `drift` trace counter-steers the way a driver does, so a tuning
A/B measures the car. `held drift` reports the longest unbroken stretch
between 12° and 55° and how many separate stretches there were — one long
drift and two with a transition between them are very different cars, and
`max drift` counts a spin as a triumph.

The crash cinematic (time dilation and a ducked mix) is off with `?drama=0`,
with the `K` key, or by setting `settings.drama` to 0 — at 0 it is genuinely
inert, not merely quiet. The harness steps the world directly and never sees
it; `uicheck` passes `drama=0` anyway.

## Working cheaply

Context is the scarce resource, and so is wall-clock time on a machine that runs
a physics engine per test. These are the habits that pay:

- **Reproduce the report before designing the fix.** Told the car drove through
  trees, I spent several rounds reasoning from the corridor geometry about
  whether it even could — one `shoot` frame settled it, and the answer was not
  the one the reasoning was heading for. Cheap evidence first, then theory.
- **Answer from text, not from images.** A `shoot` composite is by far the most
  expensive thing here — one image is worth thousands of tokens and a minute of
  Chromium. `telemetry`, `sweep`, `stages` and `perf` answer most questions for
  the price of forty lines. When an image *is* the answer, take one grid with
  every case in it rather than four images.
- **Read the block, not the file.** `grep -n` for the symbol, then read the
  forty lines around it. The 1 700-line `main.ts` and 1 200-line `stageMesh.ts`
  are almost never worth reading whole; their per-function comments are.
- **Grep for the shape of the thing.** Deriving the import graph with one
  `grep -rho "from '[^']*'"` beats opening seven directories, and it found the
  one upward import in `sim/` that a guess would have missed.
- **Bisect by toggling a constant, not by reasoning.** When Grand Traverse went
  red, setting `SOLID_MARGIN = -999` for one run proved in ninety seconds that
  the new colliders were *not* the cause — three rounds of plausible theory
  would have been slower and wrong.
- **Test the rule, not the game.** `tests/gates.test.ts` feeds `Race` positions
  directly instead of driving the physics: the question was whether the rule was
  right, and a full sim run only makes it slower to find out that it was not.
  Reserve the expensive integration path for things only it can catch.
- **Measure before and after, on the same machine, twice.** `perf` numbers move
  40% under load — one run showed 166 µs/step and the next 124 for identical
  code. A single measurement is not evidence.
- **Put long runs in the background** and keep working; `npm test` is ~100 s and
  `npm run stages` several minutes.
- **Apply mechanical multi-hunk edits with one patch script** in the scratchpad,
  written with `assert old in s` for every hunk. It fails loudly on a stale
  assumption instead of silently matching nothing, which a fuzzy edit will do.
  Watch the indentation in the pattern: a hunk that silently matches nothing
  because it was written with eight spaces and the file has six is the failure
  mode this style exists to prevent. Long scripts go in a file rather than down
  a heredoc — Git Bash mangles the terminator on scripts with many quoted
  blocks, and the resulting error points at the wrong line.
- **Throwaway scripts go in the scratchpad, and get deleted.** A `.tmpcheck/` in
  the repo is fine while it is being used and must not survive the change.
- **Never copy `node_modules` into a comparison worktree.** `git worktree add`
  then a `cp -r` of the dependency tree filled the disk and made an unrelated
  write fail. Symlink it, or run the harness from the main tree against the
  worktree's sources.

## Things that have already gone wrong here

Each of these cost real time and is easy to repeat. Grouped so the list stays
scannable as it grows; it is append-only.

### Simulation, determinism and units

- **`process.env` anywhere under `src/`.** It is undefined in the browser and
  throws. One debug line inside a Rapier contact callback silently killed every
  impact in the game while the headless tests stayed green.
- **Reaching for `Math.random` in `sim/` or `game/`.** Headless runs must be
  reproducible; stochastic behaviour draws from an injected stream — and the
  *default* has to be a seeded stream too. `random ?? Math.random` looks
  harmless and quietly made every run with a damage model non-reproducible;
  nothing failed until a test compared two identical runs.
- **A calibration constant whose comment describes an outcome it stopped
  producing.** `STRIKE_CONCENTRATION` said a 90 km/h deer strike wrote off the
  front end; measured, it left the radiator at 78% and a bill of 584. The damage
  thresholds had moved underneath it over months and nothing recomputed it,
  because nothing links them. Every number calibrated against another number's
  outcome — deer strikes, medal times, the AI's grip budget — is stale by
  default and only true when it was last measured. The comment is where the
  measurement goes, and re-running it is the only way to know.
- **Trusting a metric without checking what it counts.** `timeAirborne` counted
  any moment with no wheel down, so a beached car read as a 45-second jump.
- **Measuring a stop at the standstill.** The slip-ratio denominator clamps at
  1 m/s, so every wheel reads locked at walking pace whatever it was doing at
  speed. Sample mid-stop; a slip ratio taken at the end told me the car was
  locking when it was not, and I nearly retuned the tyre model on it.
- **Reading a per-step peak as if it were an event.** `world.lastImpact` is the
  hardest contact of the step just taken, and a car rolling down an embankment
  is in contact on every one of them. Used directly it re-armed the camera shake
  every frame, so the camera stayed at full amplitude for the whole crash
  instead of being knocked once and settling — which is what "the slow motion
  shakes the whole time" was. A shake is one per impact: keep a decaying bar the
  next hit has to clear.
- **Using the physics `dt` for something a person experiences as a duration.**
  The frame delta is capped at 0.1 s so a stall cannot hand the accumulator a
  second to catch up on in one go. The start countdown ran on that capped
  clock, so on a machine managing a few frames a second a four-second countdown
  took most of a minute. `wallDt` is the real one; `dt` is only for the world.
- **Reading a raw quaternion component as if it were an angle.** They are only
  proportional near zero. A test asserting the car still steers under braking
  read `body.rotation().y` and saw 0.007 against a 0.02 bar while the car was
  rotating seventy degrees.

### Geometry, handedness and gates

- **A vector named `right` that was the left.** `cross(up, forward)` in a
  right-handed Y-up world with the nose along +Z points to the car's *left*.
  Named `right` on the spline sample it read as obviously correct in a dozen
  places, and the steering, the AI's recentring and the camera zones were all
  built on it. Pressing right turned the car left, and every tool agreed,
  because every tool shared the convention. Settle handedness by driving the
  car and projecting the result through the real camera — never by reasoning
  about it, which got it wrong three times in a row here.
- **Getting left and right the wrong way round, consistently.** The car's right
  is **-X**: nose along +Z, up along +Y, right-handed. Every table in the game
  had it mirrored — wheel mounts, damage components, detachable parts and
  meshes — so nothing looked wrong until the damage panel reported a folded
  left wing after a hit on the right. `tests/handedness.test.ts` drives the car,
  sees which way it actually goes, and checks all four tables against that. A
  mirror applied to three of them is worse than a mirror applied to none.
- **A lateral offset taken from the nearest spline *sample*.** It is right on a
  straight and wrong through a hairpin, where the nearest sample is across the
  apex from the car. Used to decide whether a checkpoint had been driven
  through, it reported the AI's own clean lap as twelve metres off the
  centreline and marked every gate on Grand Traverse missed. Test a gate as a
  plane with a width, from the gate's own position, forward and left.
- **A trigger tested only along a plane's normal.** The plane is infinite. A car
  four hundred metres away but momentarily level with a gate's plane counted as
  crossing it, and three of four stages in one screenshot were telling the
  driver they had missed a checkpoint still half a stage ahead. Check the
  distance to the gate, not to its plane.
- **A stage passing over itself.** `selfIntersections` skips pairs at different
  heights, so a section running 12 m above another and 1 m across from it was
  never reported — and the ground mesh, which took the *nearest* road's height,
  then stepped twelve metres inside one 22 m cell. That cliff is where strange
  shadows around a doubled-back stage come from. The ground takes the *lowest*
  nearby road now, and `npm run stages` prints how close each stage comes to
  itself: every healthy one is 32–45 m.
- **Scattering scenery near a stage that loops back on itself.** Scenery reaches
  a hundred metres out and Pine Loop passes within thirty-two of itself, so a
  pine placed off one leg stands in the middle of another. Harmless while it was
  only drawn; given a collider it was a tree in the road, and it cost the AI ten
  seconds in that stage's first sector. Solidity asks the road — `spline.locate`
  — never the scatter that placed it.
- **Measuring a yawed box by its longest side.** A stone wall is three metres
  long and half a metre thick; which of those faces the road decides whether it
  is a wall beside a street or a barrier across it. Project the box's own axes
  onto the road's `left`. Getting this wrong once rejected every wall on the
  town stage, and once built them all lying across the road, so a village
  rendered as a flight of steps.
- **Moving a checkpoint.** Hazards are kept clear of every gate, so a gate that
  moves reshuffles every prop downstream of it. Nudging gates onto straighter
  road was a real improvement and cost Grand Traverse's reference lap fifteen
  seconds against medals calibrated on the old one. It was reverted. Anything
  that changes gate positions has to be checked with `npm run stages` against
  the times already in `src/data/stages/`.

### Rendering

- **Fixing a thing in the road by making it intangible.** Scenery that landed
  on driveable road had its collider suppressed and was drawn anyway, so twelve
  conifers stood in the middle of Pine Loop, sixty boulders and fifteen firs on
  Grand Traverse and four houses on Vieux Village, and the car went through all
  of them. That is the same bug as placing them in the renderer, one layer up:
  the question is asked at *placement* now and anything on the road is not put
  there at all. `onDriveableRoad` in `sim/scenery.ts`.
- **Displacing a mesh's vertices by their index.** Every polyhedron three builds
  is non-indexed, so one corner exists three times over and a per-index hash
  moves each copy somewhere different — the solid comes apart along every edge.
  At `DodecahedronGeometry(1.1, 1)` scaled to a 2.6 m boulder that is gaps you
  can see through, and the big rocks read as a pile of flakes. Hash the vertex
  *position*, quantised, so a shared corner moves once.
- **A refactor that leaves a term feeding nothing.** The windscreen shader split
  the swept glass and the crust into two numbers that are composited separately,
  and the wiper carried on modifying the old combined one — which by then only
  fed the blur. So the blade cleared nothing visible, was never drawn, and the
  screen simply snapped clean when the simulation dropped its soiling. Nothing
  errored. When a value stops reaching `gl_FragColor`, everything written into
  it is dead code that still compiles.
- **Guessing at the height of ground somebody else is drawing.** The terrain
  mesh and the scenery scatter each had their own idea of where the ground was,
  and past thirty metres from the road they disagreed by up to a dozen metres —
  worse over a self-crossing, where one took the lowest road and the other the
  nearest. Trees hung in the air. One `groundHeight` in `sim/terrain.ts` now,
  called by both.
- **Anything the player can see that the simulation does not know about.** The
  trees, boulders and houses beside every road were placed in the renderer and
  existed nowhere else, so the car drove through all of them. The comment above
  that code said so plainly and was treated as a design note rather than a bug
  for as long as it stood. If it is drawn at the size of a thing you can hit,
  put it in `sim/` — placement, seed and all — and let the renderer read it.
- **A fixed camera that ends up in front of the car.** Camera yaw was authored
  by eye, and 60–98% of every stage was driven *toward* the viewer, which
  mirrors left and right on screen. Zone yaw is derived from the road now, and
  `tests/camera.test.ts` drives the car and checks which way it moves in screen
  space.
- **Assuming a perspective camera.** The game camera is orthographic. The
  particle shader's usual `1.0 / -mvPosition.z` size trick divides by a fixed
  ~140 m camera distance and yields sub-pixel points that never appear.
- **A ground quad wound so its normal faces down.** Every skid mark the game
  has ever laid was back-face culled and invisible; the little discs under the
  wheels were the only grip cue that ever reached the screen. Nothing errors,
  nothing warns, and the buffer fills with perfectly good geometry. Flat quads
  laid on the ground want `side: THREE.DoubleSide` unless you have checked the
  winding — and the way to check is one frame with the fragment shader forced to
  solid red, which took three guesses off the list in one shot.
- **`smoothstep` with its edges crossed over.** Adding noise to the far edge of
  a band (`smoothstep(a, b + lumps, x)`) can push it past the near one, and GLSL
  says nothing about what happens then — here it was crust blooming in the
  middle of a clean windscreen wherever the noise dipped. Offset the whole band
  instead: `smoothstep(e - w, e + w, x)` with `e` carrying the noise.
- **Scaling a mesh down to say "damaged".** A panel at half size reads as a
  smaller panel; a wrecked car built that way is a small tidy car. Damage is
  vertices moving, and the metal has to go somewhere — collapse along one axis,
  fatten across the others, and snap the displacement onto planes so the fold
  facets. `shoot --cells=garage:5000,garage:12000,garage:22000,garage:45000` is
  the ladder to judge it against.
- **A vertical face lit only by a hemisphere light.** It comes out navy whatever
  colour it is painted, so a street of cream houses rendered as dark slabs. A
  small emissive floor on the material — a tenth of its own colour — keeps a
  shape's colour in its own shadow without reading as a light source.
- **Effects written only inside the frame loop.** `shoot` and the `?stage=&t=`
  harness step the world directly and never call `frame()`, so anything that
  only lives there produces nothing in any screenshot and looks broken when it
  is merely unreachable. Put per-frame effects in a function both call.
- **Anything with a lifetime has to be advanced on *every* draw path**, and
  there are three: the live loop, `drawReplay`, and the harness seek. The camera
  shake decayed inside `camera.follow`, and the crash replay draws with
  `jumpTo` and returns before `follow` is reached — so the shake froze at full
  amplitude for the whole cinematic and stopped the instant it closed. It reads
  exactly like the slow motion causing the shake, which is what it was reported
  as, and no amount of work on the *trigger* touches it. Envelope in its own
  method, called from all of them. The
  same block also has to pose the car (`carView.update`) before reading a
  dragging part's world position, or sparks come off where the bumper sat
  before it started hanging.
- **three.js needing an explicit call after you change a shadow camera's
  frustum** (`light.shadow.camera.updateProjectionMatrix()`), and needing the
  key light on the opposite azimuth from the camera or the car sits on its own
  shadow.

### DOM and UI

- **Setting SVG `fill` with `setAttribute`.** A stylesheet rule outranks a
  presentation attribute, so the damage panel's zones stayed green however
  wrecked the car was. Use `style.fill`.
- **A cache key that does not carry everything on screen.** The HUD's split
  strip was rebuilt only when the split *count* changed, so a run stayed looking
  clean after driving round the outside of a checkpoint. If the markup depends
  on two things, the key has both.

## Multiplayer

`src/net/` is the protocol, the host, the guest and the transports; `src/sim/`
knows nothing about any of it. Three things there are easy to get wrong twice:

- **`npm run netcheck` drives both directions.** It used to drive only the host
  and check the guest saw it, which left "the joiner's car does not move on my
  screen" untestable — guest inputs travelling *up* the wire and being applied
  by the host is a different path from snapshots coming down it.
- **A guest's own car is index 0 in its own world**, and the host's numbering is
  a swap away (`RaceGuest.swap`). Everything above the simulation assumes the
  local car is the first one; the permutation lives at the wire and in
  `WorldOptions.slots`.
- **Test the protocol over `LoopbackWire`, not over WebRTC.** It has simulated
  latency, loss and a manual clock, so "what does a client do with a snapshot
  that arrives 200 ms late" is a test rather than a hope. `npm run netcheck` is
  the only thing that needs two real browsers, and it exists to prove the
  transport and the lobby, not the netcode.

Two browsers on one machine both render through software WebGL and only one of
them is ever in front, so a page can run at two frames a second: `netcheck`
turns off the vision pass, uses a small viewport, and enables CDP focus
emulation. Without that the "host" barely moves and the netcode gets the blame.
The same slowness is why `netcheck` waits for `.lights-word.go` rather than for
a duration — the start countdown runs on frame time, so on a page managing one
frame a second it takes minutes of wall clock, and the host presses the throttle
against the handbrake.

The exchange itself is a link, not a code: `?join=<code>` opens the game with
the invite already applied, so the joiner's whole side is tap the link, tap
send. The raw code stays behind a `details` for the browsers that refuse a
share sheet or a clipboard read — `netcheck` drives the link on the guest and
the by-hand fallback on the host, so both paths are covered.

The invite codes are a compact encoding of the five things that matter in an
SDP — ICE username, ICE password, DTLS fingerprint, setup role, candidates —
and the rest of the SDP is rebuilt on the far side from a fixed template. That
is 96 characters against 560 for the whole thing deflated. Two rules for it:

- **`.local` mDNS candidates are kept only when there is nothing better.**
  Chrome hides local IPs behind names that resolve on their own network only.
  With a public address they are dead weight; without one they are the only way
  two players on the same wifi connect at all.
- **STUN cannot get through every NAT**, and there is no relay. `?turn=…` takes
  one; a failure without one is reported as needing a relay rather than left as
  a lobby doing nothing.

Two lifetime bugs, both of which read as "multiplayer is broken":

- **`connectionState === 'disconnected'` is transient.** Tearing the peer
  connection down on it threw away races that were about to recover, and left
  the lobby unable to set a remote description afterwards — which surfaces as
  `InvalidStateError: signalingState is 'closed'` when the reply is finally
  pasted, blaming the reply code for a connection that died earlier.
- **The signalling channel is two people copying strings into a chat window.**
  A one-minute timeout fires in the middle of that. It is five now.

## Mobile

The game is played on a phone in landscape, and the checks for it live in
`npm run mobilecheck`: an 844x390 viewport, real touch events, no keyboard.
Three things there are easy to get wrong:

- **`touch-action: none` on the document is what makes steering work**, and it
  is also what stops every menu scrolling. The panels that scroll opt back in
  with `pan-y`; forgetting one means the bottom half of the stage list cannot
  be reached on a phone and nothing on a desktop ever notices.
- **The steering pad is deliberately huge and sits under the HUD.** It takes
  the whole left third so a thumb never has to aim, which is only safe while
  everything drawn over it is `pointer-events: none`. `mobilecheck` asserts
  that, and separately that no two visible panels overlap — a landscape phone
  is ~390 px tall and every panel sized for a desktop's vertical room stacks
  into the one beside it.
- **Scenery is not a quality lever.** The trees are collidable and placed by
  the simulation, so drawing fewer on a phone leaves invisible things to hit.
  A stage is the same stage on every device; the levers are shadows, pixels,
  particles and the windscreen pass.
- **Fill rate is what a phone runs out of first**, so the adaptive
  `RenderScale` multiplies the *pixel ratio* rather than the CSS size — the
  canvas stays put and is drawn into fewer pixels. It counts *consecutive*
  slow seconds; measured as time-since-last-change instead, one stutter on a
  stage load cost a permanently softer picture. `?quality=low|medium|high`
  overrides the guess.

## Tuning and calibration

**The AI reads the car now, and only partly.** `sim/driver.ts` scales its grip
budget by `gripFactor` (how this car's `tireGrip` and `peakSlipAngle` compare to
the tuning the budgets were calibrated at) so a tyre change moves the AI's corner
speeds instead of leaving it planning at speeds the car no longer has. Both
reference constants are the values at calibration, which is what makes the factor
exactly 1 there — every `gripBudget` in the codebase keeps the meaning it was
chosen with.

Steering is compensated the other way and only halfway, and the split is
measured rather than reasoned. `DriverInput.steer` is a *fraction of lock*, so
changing `maxSteerAngle` or the speed falloff changes the angle the AI gets for
the same output. Its **pursuit** term wants that extra authority — compensating
it cost Grand Traverse 13 s. Its **recentring** term is a stabiliser whose gain
was chosen against the old lock — not compensating it cost Vieux Village 12 s
and put a clean run into the walls. `steerScale` compensates exactly one.

**Medal times are calibrated against an AI lap, so the car changing invalidates
all thirteen tables.** They are hand-written constants in `data/stages/index.ts`
and `data/stages/generated.ts`; nothing recomputes them, `generate` only makes
new stages, and variant times are derived from them by a hand-calibrated
`timeScale` so they inherit the staleness. Rebase them by scaling each table by
that stage's own before/after ratio from `npm run stages` — which preserves how
hard each stage was meant to be, rather than re-deriving from a single set of
ratios and flattening the differences.


`src/data/tuning.ts` holds every magic number for the car; nothing else should
carry one. The live panel (`T` in game) mutates that object directly, and
**Copy setup** gives back only the changed values, ready to paste.

Numbers in units nobody has intuition for are calibrated against a measurement,
not guessed. Damage thresholds are newton-seconds, set with `npm run crash`;
medal times come from a measured AI lap; crest geometry comes from the actual
condition for a car leaving the ground (`v² / R > g`).

## Stages

Stages are data — a centreline of control points, each with a width and a
surface. Road, verges, embankments, colliders, hazards and gates are all
generated from that. Two constraints are not obvious and are enforced in code:

- A corridor is about 27 m wide, so a centreline that doubles back within that
  distance produces overlapping ribbons and buries the car in an embankment
  belonging to a section it has not reached. `Stage.selfIntersections()` checks
  this and `npm run stages` reports it.
- Stages need a start apron and a finish run-off, or a car that drifts a few
  centimetres backwards off the line falls out of the world.

After changing stage data or vehicle physics, re-run `npm run stages`: it is the
only thing that will tell you a stage stopped being completable.

Where a stage passes over itself at height it gets a bridge, found rather than
authored: `Stage.crossings` looks for the pair scan's *opposite* case to
`selfIntersections` — overlapping road with a large height gap instead of a
small one — and puts piers under each end of the span. Grand Traverse has two,
at 46 m and 20 m of headroom. A hand-placed bridge would be in the wrong place
the first time a control point moved.

Scrubbed Flats is the jumps stage, and it is calibrated differently from the
rest: the whole lap is speed against vertical geometry, so a lip half a metre
lower is a different stage. The condition for leaving a crest is `v² / R > g`,
which is checkable from the control points without driving anything — every jump
on it launches the car between 78 and 92 km/h, and the AI spends 3.0 s of a 49 s
lap in the air. Re-measure that and re-derive the medals if any of it moves.

Grand Traverse is the fragile one, and its night-snow variant is the canary.
`validateStage` drives each variant three times at rising commitment and wants
two finishes; on that stage the over-committed run is genuinely off the road a
quarter of the time, so it sits one perturbation away from failing. A change
with no behavioural content — a prop a metre to the left — can flip it. When it
goes red, measure whether the cause is the change or the chaos before fixing
anything.

Every collider is a broadphase entry and they are not free. The roadside wood is
solid out to `SOLID_MARGIN` past the corridor wall for exactly that reason:
measured, colliding everything within forty-six metres more than doubled the
cost of a stage step to hold trees no car can reach. `npm run perf` is the check
before widening it.

## Committing

Commit messages explain why a change was needed and what measurement drove it,
not just what moved. If a bug was found by measuring rather than by reading,
say what the measurement showed — that is the part worth keeping.
