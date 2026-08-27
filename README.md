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
`Q` rescue, `Esc` for the garage (`1`–`3` picks a stage there), `T` for the live
tuning panel, `M` to mute.
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
npm run generate   # make new stages, validate them, calibrate their medals
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

### Generated stages

A stage is only a centreline, so generating one is a walk: pick a heading, step
forward, turn by a bounded amount, repeat. Everything visible is already derived
from that, so the generator never touches geometry.

What makes the output shippable is the validation, not the generation. Every
candidate must survive three checks — its corridor must not run into itself, its
corners must be drivable, and the AI driver must get round it at several
different grip budgets, because a stage that only works for one driving style is
not a good stage. Medal times and payouts are then calibrated from the measured
laps, with the AI's time anchoring silver so gold and author are left for a
human.

```bash
npm run generate -- --count=8 --biome=coast --write
```

In practice the layout constraints reject far more candidates than the driving
test does — bounded turn angles and a minimum separation between passes catch
most bad stages before the physics ever runs. The drivability check earns its
place as the net underneath: it is what would catch a regression in the
generator or in the car, and a test drives it against a deliberately
undriveable stage to prove it still bites.

The six stages currently in `src/data/stages/generated.ts` came out of this and
sit alongside the three hand-authored ones. They are the same kind of data and
go through exactly the same code — the only difference is that a person picked
the corners of the first three.

### Desktop build

```bash
npm run desktop:dev     # run the game in a native window
npm run desktop:build   # produce an installer
```

Tauri rather than Electron: the game is entirely front-end code, so the desktop
shell is a window and nothing else — no commands are exposed to the web layer.

Building it needs the Rust toolchain plus the platform's webview development
packages. On Debian/Ubuntu that is `webkit2gtk-4.1` and `librsvg2-dev`; see
[the Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for
Windows and macOS. The desktop shell has **not** been compiled and run — the
sandbox this was built in has Rust but no webview libraries, so the
configuration is correct and unproven.

`npm run icon` regenerates the application icon, which is drawn in code rather
than committed as an undiffable binary.

### Sound

The engine is synthesised, not sampled. A four-stroke four-cylinder fires twice
per revolution, so the fundamental is rpm/30 Hz, and everything is built on
that: a sawtooth for the body, an octave up for the bark, an octave down for the
rumble, and filtered noise for induction. A low-pass that opens with throttle is
what makes on-power and off-power audible — the single most useful thing engine
audio can tell a driver.

Synthesis because it tracks rpm continuously with no crossfade seams, costs
nothing to ship, and responds instantly to a misfire or a dying engine. Tyre
roll and skid are noise shaped per surface, so gravel rattles and ice whines,
and both vanish the moment the car leaves the ground.

### Economy

The economy exists to give damage a consequence. Repairs are the cost of how you
drove, entry fees the cost of where you race, payouts what you earn back. The
tension is that a good run on an expensive stage pays less than a bad crash
costs, so pace has to be weighed against risk rather than simply maximised.

**Damage belongs to the car, not the run.** It follows you to the next start
line unless you pay to put it right, and a failed component stops you entering
at all — which is what makes declining a repair a real gamble rather than free
money. When funds are short the interesting move is partial: fix the radiator so
the car can finish, and live with the bent panels.

Restarting a paid stage charges the entry fee again, so a committed run is
different from an idle retry. The free stage stays freely retryable, which keeps
the Trackmania practice loop intact, and its payout always covers the cheapest
paid entry — being broke is a setback, never a dead end.

Every upgrade is a trade rather than a straight gain: grippier tyres let go later
but more abruptly, a rollcage costs weight and protects nothing cosmetic, weight
reduction makes the car better in every direction and less forgiving of impacts.
An upgrade tree where every purchase is strictly better turns money into a
formality.

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
- **P5 — Economy** ✅ money, entry fees, medal payouts, damage that carries
  between races, itemised repairs you can decline, eight upgrades that are each
  a trade, and a garage to weigh it all up in.
- **P6 — Juice** ✅ surface-coloured wheel spray, skid marks, camera shake and
  speed-linked zoom, and a fully synthesised engine that tracks rpm, throttle
  and engine condition.
- **P7 — Scale & ship** ✅ seeded stage generation across five biomes with
  AI-driven validation, and a Tauri desktop shell.
