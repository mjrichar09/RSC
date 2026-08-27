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

**Controls** — `WASD` / arrows to drive, `Space` handbrake, `R` reset,
`T` for the live tuning panel. Gamepads work too (triggers for throttle/brake,
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
npm run shoot -- --grid=1x1 --cells=circle@8 --size=900x560 --out=inspect
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
| `src/data/` | `tuning.ts` holds every magic number; stage and ground data. |
| `tools/` | `headless.ts` (telemetry), `shoot.ts` (composite screenshots). |

The sim runs at a fixed 120 Hz; rendering interpolates between the last two
steps, so handling is identical on any display refresh rate.

Ghosts (P3) will record sampled transforms rather than replaying inputs, so
nothing depends on bit-exact physics determinism surviving future refactors.

## Roadmap

- **P0 — Scaffold** ✅ fixed-timestep sim, raycast-suspension car, tire model,
  isometric camera, HUD, and the full verification harness.
- **P1 — Vehicle feel** ✅ limited-slip diffs, engine braking, live tuning panel,
  and a steady-state sweep tool. Tarmac grip went from 0.67 g cornering on two
  wheels to a flat 1.05 g on all four, and throttle now genuinely rotates the car.
- **P2 — Stages.** Spline road generation, checkpoints, timing, medals, camera zones.
- **P3 — Ghosts.** Record, replay, split deltas, instant restart.
- **P4 — Damage.** Component graph, impact mapping, failures, damage HUD.
- **P5 — Economy.** Entry fees, payouts, repair bills, upgrades, career.
- **P6 — Juice.** Particles, skids, audio, stylized shading, replay cam.
- **P7 — Scale & ship.** Procedural stage generation, Tauri desktop build.
