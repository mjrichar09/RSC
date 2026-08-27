# RSC — Rally Stage Challenge

A top-down/isometric rally racing game: Trackmania's time-attack loop and ghost
chasing, RalliSport Challenge's point-to-point stages and surfaces, and a
component-level damage model with real repair bills and an economy on top.

**Fun to drive comes first.** Everything else — stages, ghosts, damage, money —
only matters if throwing the car sideways into a gravel hairpin already feels
great on an empty plane.

## Stack

TypeScript · [Three.js](https://threejs.org) · [Rapier](https://rapier.rs)
physics · Vite · Vitest · Playwright. No engine editor: every part of the game
is a source file.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

**Controls** — `WASD` / arrows to drive, `Space` handbrake, `R` restart,
`Q` rescue, `1`–`3` to pick a stage, `T` for the live tuning panel.
`?free` opens the flat proving ground instead of a stage. Gamepads work too (triggers for throttle/brake,
`A` for handbrake).

The tuning panel edits the car while you drive — every slider takes effect on
the next physics step — and shows the numbers you cannot judge by eye: lateral
g, front/rear balance, and per-wheel load and grip saturation. **Copy setup**
puts the changed values on the clipboard, ready to paste into
`src/data/tuning.ts`.

## Verification

```bash
npm test           # unit + headless handling regression tests (text, fast)
npm run telemetry  # headless run -> speeds, drift, slide time, 0-100
npm run sweep      # steady-state cornering matrix -> grip and balance table
npm run stages     # drive every stage with the AI -> completable? how fast?
npm run crash      # drive into a wall at known speeds -> what breaks, what it costs
npm run shoot      # -> ONE composite grid PNG in shots/
npm run typecheck
```

`npm test` is the default gate for every change. Telemetry answers handling
questions in text — orders of magnitude cheaper than a screenshot — and
`shoot` is reserved for genuinely visual questions, always emitting a single
labelled composite rather than a burst of images:

`sweep` is the tuning instrument: it holds a constant corner until the car
settles and reports lateral g, turn radius, and front-minus-rear slip angle, so
balance is measured rather than guessed. Both it and `telemetry` take
`--set=key=value,...` to try a setup without editing a file.

```bash
npm run sweep -- --steer=0.3,0.5,0.7,1.0 --surface=gravel
npm run sweep -- --set=lsdBias=0.2,yawDamping=2600
npm run telemetry -- --trace=launch,slalom --surface=gravel --csv
npm run shoot -- --grid=2x2 --cells=launch@2,slalom@6,handbrake@5.6,circle@8
npm run shoot -- --cells=ghost:pine-loop@30 --grid=1x1 --size=900x560
npm run shoot -- --cells=trace:circle@8 --grid=1x1 --size=900x560 --out=inspect
```

## Architecture

The one structural rule: **`src/sim/` never imports Three.js.** That is what
lets the entire simulation run in Node, which is what makes the headless
telemetry and the regression suite possible.

| Path | Role |
|---|---|
| `src/sim/` | Physics, vehicle, tires, traces, telemetry. Headless, Node-runnable. |
| `src/render/` | Three.js. Reads sim state, never writes it. |
| `src/ui/` | DOM overlay — HUD and input mapping. |
| `src/game/` | Race rules: timing, checkpoints, medals, and saved progress. |
| `src/data/` | `tuning.ts` holds every magic number; `stages/` holds stage definitions. |
| `tools/` | `headless.ts` (telemetry), `sweep.ts` (balance), `stages.ts` (validation), `shoot.ts` (composites). |

The sim runs at a fixed 120 Hz; rendering interpolates between the last two
steps, so handling is identical on any display refresh rate.

### Damage

Every part that can break is a component with a position on the car, a
toughness and a repair cost. An impact is resolved to a point on the chassis and
each component takes damage in proportion to how close it is and how hard the
hit was — so a nose-first hit wrecks the radiator and the front suspension,
while the same energy on the rear quarter mostly costs panels.

Two rules shape it. Effects are **continuous and always legible**: a component at
70% degrades the car by a felt amount, and the HUD names the worst one rather
than saying "damaged". Total failures are **rare, loud, and always the
consequence of something you saw happen** — a holed radiator does not stop you,
it gives you about thirty seconds.

Thresholds are in newton-seconds, which nobody has intuition for, so they are
calibrated with `npm run crash` against measured impacts rather than guessed. A
flat nose-first hit produces roughly 350 N·s per km/h of entry speed:

| Entry | Outcome |
|---|---|
| 20 km/h | a scrape — paint and a light, ~120 |
| 50 km/h | radiator holed, panel wrecked, ~980 |
| 70 km/h | engine down to 67%, steering bent, ~2 600 |
| 130 km/h | engine seized — the race is over |

Stages are lined with trees, rocks and bales because without them the damage
model has nothing to act on: the embankments are shallow ramps, so a car that
runs wide climbs one and slides back with far too little force to hurt anything.
The hazards are what make running wide a decision rather than an inconvenience.

### Ghosts

Ghosts store sampled transforms, not inputs. Replaying inputs would be smaller,
but it would make every saved ghost depend on the physics producing bit-identical
results forever — so any tuning change would silently corrupt every time a player
had ever set. Recording where the car actually was costs a couple of hundred
kilobytes and survives everything.

Each frame also records how far along the stage the car had got, which is what
makes the live delta meaningful: it compares your clock against the ghost's clock
*at the same point on the road*, not at the same moment in time.

### Stages

A stage is data, not a scene: a centreline of control points, each with a width
and a surface. Everything else is generated from it — the road ribbon, the
verges, the containment embankments, the collider, checkpoint gates and edge
markers — so a stage costs a few dozen lines rather than an afternoon in an
editor, and the mesh you see is built from the exact vertices the physics uses.

`npm run stages` drives each one with the AI and reports whether it is
completable, how long it takes, how much of the run is off the road, and whether
the corridor runs into itself. That last check matters: a centreline that
doubles back within ~27 m produces two overlapping ribbons, and the car ends up
buried in an embankment belonging to a section it has not reached yet.

## Roadmap

- **P0 — Scaffold** ✅ fixed-timestep sim, raycast-suspension car, tire model,
  isometric camera, HUD, and the full verification harness.
- **P1 — Vehicle feel** ✅ limited-slip diffs, engine braking, live tuning panel,
  and a steady-state sweep tool. Tarmac grip went from 0.67 g cornering on two
  wheels to a flat 1.05 g on all four, and throttle now genuinely rotates the car.
- **P2 — Stages.** Spline road generation, checkpoints, timing, medals, camera zones.
- **P3 — Ghosts** ✅ your best run per stage recorded, saved to IndexedDB and
  replayed as a translucent chase car, with a live delta and per-checkpoint
  split deltas against it.
- **P4 — Damage** ✅ 31 components with their own toughness and repair cost,
  impacts resolved to where they actually landed, continuous handling effects,
  heat and fuel, race-ending failures, and a damage HUD that names what broke.
- **P5 — Economy.** Entry fees, payouts, repair bills, upgrades, career.
- **P6 — Juice.** Particles, skids, audio, stylized shading, replay cam.
- **P7 — Scale & ship.** Procedural stage generation, Tauri desktop build.
