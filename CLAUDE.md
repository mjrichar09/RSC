# RSC — working notes

A top-down/isometric rally racer. Read `README.md` first for what the game is;
this file is about how to work on it without falling into the holes I already
fell into.

## The one structural rule

**`src/sim/` must never import three.js.** The whole simulation runs in Node,
which is what makes `npm test`, `npm run telemetry`, `npm run sweep`,
`npm run stages`, `npm run perf` and the stage generator possible. Rendering
reads simulation state; it never writes it.

`src/render/` may import from `sim/`. Never the reverse.

## Verify with numbers before pictures

The cheap checks come first, and most questions never need an image:

```bash
npm test           # the default gate for every change
npm run telemetry  # handling questions, in text
npm run sweep      # balance: lateral g, turn radius, front-minus-rear slip
npm run stages     # is every stage still completable, and how fast
npm run crash      # what an impact at a given speed breaks and costs
npm run telemetry -- --trace=stops --damage   # brake temperature
npm run crash -- --drop=1,3,5 --pitch=0.35    # what a landing costs
npm run crash -- --balance=45,66              # can it sit on two wheels?
npm run crash -- --deer=60,90,120             # what a deer strike costs
npm run perf       # simulation cost per step
npm run shoot      # ONE composite grid PNG, only for visual questions
npm run netcheck   # two browsers, one race — the only test of the real transport
```

`shoot` always emits a single labelled grid rather than a burst of images, and
prints the game's own status JSON beside each frame. Reach for it when the
question is genuinely "does this look right", not before.

`telemetry`, `sweep` and `stages` all take `--set=key=value,...` to try tuning
values without editing and reverting a file.

The crash cinematic (time dilation and a ducked mix) is off with `?drama=0`,
with the `K` key, or by setting `settings.drama` to 0 — at 0 it is genuinely
inert, not merely quiet. The harness steps the world directly and never sees
it; `uicheck` passes `drama=0` anyway.

## Things that have already gone wrong here

Each of these cost real time and is easy to repeat:

- **`process.env` anywhere under `src/`.** It is undefined in the browser and
  throws. One debug line inside a Rapier contact callback silently killed every
  impact in the game while the headless tests stayed green.
- **A vector named `right` that was the left.** `cross(up, forward)` in a
  right-handed Y-up world with the nose along +Z points to the car's *left*.
  Named `right` on the spline sample it read as obviously correct in a dozen
  places, and the steering, the AI's recentring and the camera zones were all
  built on it. Pressing right turned the car left, and every tool agreed,
  because every tool shared the convention. Settle handedness by driving the
  car and projecting the result through the real camera — never by reasoning
  about it, which got it wrong three times in a row here.
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
- **Setting SVG `fill` with `setAttribute`.** A stylesheet rule outranks a
  presentation attribute, so the damage panel's zones stayed green however
  wrecked the car was. Use `style.fill`.
- **Trusting a metric without checking what it counts.** `timeAirborne` counted
  any moment with no wheel down, so a beached car read as a 45-second jump.
- **Reaching for `Math.random` in `sim/` or `game/`.** Headless runs must be
  reproducible; stochastic behaviour draws from an injected stream — and the
  *default* has to be a seeded stream too. `random ?? Math.random` looks
  harmless and quietly made every run with a damage model non-reproducible;
  nothing failed until a test compared two identical runs.
- **Measuring a stop at the standstill.** The slip-ratio denominator clamps at
  1 m/s, so every wheel reads locked at walking pace whatever it was doing at
  speed. Sample mid-stop; a slip ratio taken at the end told me the car was
  locking when it was not, and I nearly retuned the tyre model on it.
- **Effects written only inside the frame loop.** `shoot` and the `?stage=&t=`
  harness step the world directly and never call `frame()`, so anything that
  only lives there produces nothing in any screenshot and looks broken when it
  is merely unreachable. Put per-frame effects in a function both call. The
  same block also has to pose the car (`carView.update`) before reading a
  dragging part's world position, or sparks come off where the bumper sat
  before it started hanging.
- **Scaling a mesh down to say "damaged".** A panel at half size reads as a
  smaller panel; a wrecked car built that way is a small tidy car. Damage is
  vertices moving, and the metal has to go somewhere — collapse along one axis,
  fatten across the others, and snap the displacement onto planes so the fold
  facets. `shoot --cells=garage:5000,garage:12000,garage:22000,garage:45000` is
  the ladder to judge it against.
- **three.js needing an explicit call after you change a shadow camera's
  frustum** (`light.shadow.camera.updateProjectionMatrix()`), and needing the
  key light on the opposite azimuth from the camera or the car sits on its own
  shadow.

## Multiplayer

`src/net/` is the protocol, the host, the guest and the transports; `src/sim/`
knows nothing about any of it. Two things there are easy to get wrong twice:

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

## Tuning and calibration

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

## Committing

Commit messages explain why a change was needed and what measurement drove it,
not just what moved. If a bug was found by measuring rather than by reading,
say what the measurement showed — that is the part worth keeping.
