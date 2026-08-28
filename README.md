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

**In a browser, with nothing installed:** <https://mjrichar09.github.io/RSC/> —
published from this branch on every push. Progress is stored per browser, so a
career started there is separate from a local one.

**Locally**, which is the only way to use the tuning panel's Copy setup and the
verification tools:

```bash
npm install
npm run dev        # http://localhost:5173
```

**Controls** — `WASD` / arrows to drive (the brake ramps, so it can be
feathered), `Space` handbrake, `R` restart,
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
npm run perf       # simulation cost per fixed step, GPU-independent
npm run shoot      # -> ONE composite grid PNG in shots/
npm run netcheck   # two browsers, one race: the WebRTC path end to end
npm run uicheck    # career, arcade and multiplayer all open from the menu
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
npm run crash -- --drop=1,3,5 --pitch=0.35 --roll=0.45   # what a landing costs
npm run crash -- --deer=60,90,120                       # what a deer strike costs
npm run crash -- --balance=45,66                        # can it sit on two wheels?
npm run telemetry -- --trace=stops --damage             # brake temperature
npm run sweep -- --steer=0.3,0.5,0.7,1.0 --surface=gravel
npm run sweep -- --set=lsdBias=0.2,yawDamping=2600
npm run telemetry -- --trace=launch,slalom --surface=gravel --csv
npm run shoot -- --grid=2x2 --cells=launch@2,slalom@6,handbrake@5.6,circle@8
npm run shoot -- --cells=ghost:pine-loop@30 --grid=1x1 --size=900x560
npm run shoot -- --cells=trace:circle@8 --grid=1x1 --size=900x560 --out=inspect
```

## Performance

The simulation is not the constraint. Measured with `npm run perf`, one fixed
step on a stage with damage, wildlife and weather costs about 100 µs, so the 120
steps that make a second of game time cost roughly **12 ms of CPU per second** —
about 1% of one core, with eighty times more headroom than that needs. Building
a stage, which happens on load, takes under 3 ms.

Debris is free once it stops moving: Rapier sleeps resting bodies, so a stage
strewn with wreckage measures the same as a clean one. The bill is paid while
parts are in the air, at about **8 µs per part per step** — a whole car shedding
at once takes the step from 115 µs to 260 for the couple of seconds they spend
bouncing. That is what the eighteen-body budget is set from, and it is why the
cap recycles the body furthest from the car rather than the oldest: the cost is
bounded either way, but deleting the bumper lying across the road ahead of you
while a door two corners back survives is the one thing it must not do.

A full multiplayer grid costs about **223 µs a step** — 27 ms of CPU per second
of game, and still 37 times more headroom than it needs. Four cars is not four
times one: the road, the wildlife and the weather are simulated once whoever is
racing on them, and the extra bill is three more vehicles and the contacts
between them. The host pays it on top of its own rendering, which is the machine
to watch.

Every case is measured several times, interleaved, and the minimum reported.
Measuring each once in sequence had this tool confidently reporting a wrecked
stage as faster than a clean one — timing noise on a shared machine is worth a
factor of two, and it only ever adds.

Rendering will dominate on any real machine, and a flat-shaded low-poly scene
gives a modern GPU very little to do. The only figures measured under an actual
GPU are still outstanding — everything here ran under software rendering.

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

### Conditions

A stage can be raced under different **variants** — clear daylight, dusk, night,
rain, fog, night snow — and each one is its own race with its own record, ghost,
medals, entry fee and payout. Weather changes grip as well as visibility, and it
does so per surface rather than as a flat multiplier: rain costs tarmac far more
than gravel, which was loose to begin with, and rain on ice is the worst
combination in the game.

Night is where the `lights` component finally earns its repair cost. Two
spotlights are parented to the car with their intensity, cone and range scaled
by that component's health; below half, one side dies and the beam goes
lopsided. On a night variant that is the difference between seeing the next
corner and guessing at it.

The AI driver reads the spline, so **visibility does not slow it down** — its
lap on a night variant is optimistic, and those variants' medal times carry a
stated visibility allowance on top of the measured grip effect. That factor is
an estimate, not a measurement, and it is the first thing to re-tune once a
human has driven a night stage properly.

### Brakes

Brake discs have a temperature in degrees, not in arbitrary units: friction
power is brake torque times wheel speed, the disc is 1 500 J/K — about 3.3 kg of
steel, a small gravel disc — and it sheds heat by convection with airflow. A
hard stop from 140 km/h puts roughly 110 K into each front disc, and the time
constant is about 80 seconds, so heat accumulates across a stage instead of
vanishing between corners. Ambient air comes from the conditions, so a winter
night genuinely cools the brakes better than a hot afternoon.

Past about 520 °C they fade, and a damaged brake starts fading at 356 °C. It is
a real loss, not a colour: a stop from 140 km/h takes 3.13 s cold and 6.19 s at
700 °C — 1.00 g against 0.51 g. The disc renders as a ring on the outboard wheel
face, tinting bronze from 200 °C as steel actually does and glowing from 500 °C,
and the damage panel carries a BRAKE gauge so fade has a visible cause.

Modelling the heat exposed something bigger. With a single slide floor in the
tyre model, a locked tyre kept so much grip that stamping the pedal stopped the
car exactly as fast as modulating it — threshold braking was worth nothing, and
locked wheels do no work at the caliper, so the discs never warmed. A separate
`lockedGripFloor` on the braking side of the curve, plus less brake torque, now
gives 1.00 g modulated against 0.84 g locked. The keyboard brake ramps like the
steering for the same reason: a digital pedal locks on every stop and would put
that 16% out of reach without a gamepad.

### Consequences

Parts come off. **Attachment** is tracked separately from component health,
because a bumper can be crumpled and still bolted on, or barely marked and
hanging by one mount. Impacts work the mounts loose through the same call the
damage model gets, airflow keeps working on whatever is already loose, and a
detached part becomes a real Rapier body carrying the car's velocity — your own
bumper is now an obstacle on the road. Loose bodies are capped at twelve and
cleared once they are well behind.

The bumper is the model case and it is two-stage: it drags, scrapes and throws
sparks for five to fifteen seconds, and then a seeded roll weighted by speed and
looseness picks the moment it lets go. Every other part gets a telegraph too —
sitting proud and skewed once it is working loose.

Landings hurt when they deserve to. Bottoming the suspension puts the car's
remaining vertical momentum through the bump stop, split across however many
corners are sharing the landing, and into the same impact pipeline. Calibrated
in metres, which is a unit you can picture: a flat landing from 3 m costs
nothing, from 5 m it is a scratch, and nose-down and rolled so one corner takes
the lot, 3 m costs 151 and 8 m costs 644 with a bent suspension.

**Two wheels: measured, and the answer is no.** `npm run crash -- --balance=`
drops the car at a roll angle and reports how long it holds two wheels. It never
holds them — from 45°, 66°, even 110° it snaps back inside half a second. The
artificial stabilisers are innocent (the anti-roll bar and yaw damping are
already gated on being grounded), and fading the suspension out with roll angle
changed nothing: the righting moment comes from the chassis collider's own
contact resolution. Making it possible means reworking that, which is a larger
change than it is worth today.

### Wildlife and the random tier

Everything that can surprise you obeys one rule:

> **Randomness decides *when* and *how spectacular*. Damage state decides
> *whether it can happen at all*. Nothing that can end a run happens without a
> prior visible cause.**

Deer are the telegraphed half. They are placed from the stage id, so they stand
in the same places on every load and a stage can be learned. They graze head-down
and side-on until the car is inside 60 m, then lift their head and turn to face
the road — the only warning there is — and then, on a roll weighted by closing
speed, about a third of them bolt across it. A strike goes through the ordinary
damage pipeline with a concentration factor, because a deer changes the car's
momentum by almost nothing and still destroys the front of it. At 35 km/h it is
a fright; at 90 it holes the radiator; at 120 the lights are gone. Never an
instant retirement — a test pins that at 200 km/h.

The random half is strictly bounded: gusts on exposed stages scaled by biome and
weather, at a tenth of a g at the very most, and stones off loose surfaces that
mark paint and lights and reach nothing that decides whether the car finishes.
Nothing blows in a forest; nothing happens to a parked car.

Both are gated on the damage model, so they are on in a race and off in stage
validation — a stage must never be judged unshippable because a deer stepped in
front of an AI that cannot see one.

### Crests

Stages carry crests: short convex rises sized so the car only leaves the ground
above roughly 90 km/h. A car leaves a crest when its radius of curvature is
smaller than v²/g, so the geometry is chosen to sit just above that at committed
pace and comfortably below it at careful pace — a jump is a reward for
commitment rather than something that happens to everyone equally.

Under a fixed isometric camera the gap between the car and its shadow is what
reads the height, which is why the key light is deliberately on the opposite
azimuth from the camera.

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

Stages unlock progressively as medals are earned — the free stage is always
open, then a gentle ramp. Nine stages available at once gives a new player no
direction and leaves the career with no shape beyond a rising balance. The
unlock order is checked by a test: with N stages open a player can hold at most
N medals, so a requirement above a stage's own position in the order would
dead-end the career with money in the bank and nothing to spend it on.

**Entry fees are shown where the decision is made** — on the button you press,
not in the small print under the biome.

**Two ways out of a hole.** A big enough accident can leave the car unable to
start and the player unable to afford the repair that would let them earn the
money for it. Every other tight spot here is a decision; that one is just over.
So the garage offers a *salvage job* when — and only when — the essential repair
costs more than the player has: it takes every penny left and puts the failed
parts back together at a quarter health. The car runs, badly, and wants doing
properly the moment there is money. It is deliberately the worst deal in the
game. Failing that, **Reset career** at the foot of the garage starts again from
nothing, behind a two-step confirmation, and keeps the player's own settings
because a windscreen preference is not a career achievement.

**Damage belongs to the car, not the run.** It follows you to the next start
line unless you pay to put it right, and a failed component stops you entering
at all — which is what makes declining a repair a real gamble rather than free
money. When funds are short the interesting move is partial: fix the radiator so
the car can finish, and live with the bent panels.

Restarting a paid stage charges the entry fee again, so a committed run is
different from an idle retry. The free stage stays freely retryable, which keeps
the Trackmania practice loop intact, and its payout always covers the cheapest
paid entry — being broke is a setback, never a dead end.

Every upgrade is a trade rather than a straight gain: a rollcage costs weight and
protects nothing cosmetic, weight reduction makes the car better in every
direction and less forgiving of impacts, and softer tyres grip harder, let go
more abruptly and wear noticeably faster. An upgrade tree where every purchase is
strictly better turns money into a formality.

**Tyres are a consumable.** They are worn by sliding rather than by rolling —
wear tracks how far past the grip limit a tyre is, scaled by the load it carries
and how abrasive the surface is. Gravel is the worst of both worlds, not grippy
enough to stop you sliding and abrasive enough to punish it; ice barely wears a
tyre at all. This is what connects driving style directly to the repair bill: a
careful lap costs a few percent of tyre life, while a committed lap on soft
compounds can cost ten times that.

### Damage you can feel

A component that changes nothing you can feel is a tax, not a consequence, and
three of them were exactly that until they were measured:

- **The steering rack** pulls hard when it is bent — 12 m of deviation in two
  seconds, hands-off, at half health. Nothing ever bent it: `npm run crash` had
  it surviving a 95 km/h nose-on impact at 87%, a pull of about a degree and a
  half. It sits across the front subframe behind a radiator made of foil, so it
  is reachable now: 77% at 51 km/h, 37% at 95. The pull is signed by whichever
  front wing is worse, so it agrees with the bodywork rather than always going
  the same way.
- **A flat tyre** drags and pulls. The drag is real rolling resistance at that
  corner and costs a third of the car's speed. The pull needed a second
  mechanism: measured, 0.3 of extra rolling resistance on one front corner moved
  the car 0.1 m sideways in two seconds, because the tyres simply take the yaw
  moment. What a driver feels in a real car is the wheel fighting them, so a
  deflated front tyre offsets the steering — 6.6 m of pull in two seconds,
  correctable but constant. A rear flat drags and does not pull, which is the
  difference worth keeping, and the corner sits down on its rim.
- **A terminal failure no longer teleports you to a results screen.** Steam
  comes out of the bonnet about eight seconds before a holed radiator finishes
  the engine. Then the engine stops — no torque, no revs, silent — and the car
  coasts. It still steers and still brakes, so you can bring it to a stop, put
  it in the scenery, or roll over the finish line on momentum. The run ends when
  the car does.

### Three ways to play

The game opens on a start menu rather than in the garage: the first question it
used to ask was "which stage will you spend money on", which is a fine second
question and a strange first one, and it left the other two modes effectively
undiscoverable.

- **Career** is the game with consequences. Damage carries between races,
  repairs cost money, stages unlock as medals are won, and every attempt on a
  paid stage costs its fee.
- **Arcade** is every stage under every condition, open from the start, free to
  enter, with a fixed car each time. Nothing is banked: no payout, no repair
  bill, no record, no ghost. Wreck the car on a night stage you have not
  unlocked and walk away as though it never happened. Your career's best time
  is still shown, to chase.
- **Multiplayer** is the lobby described above.

`npm run uicheck` drives all three from a real browser, because a menu that
fails to open is a game that cannot be played at all and no unit test would
notice.

### Places, not one place in five colours

Every stage used to be the same wood at the same spacing with the ground tinted
differently. The dressing is now a per-biome recipe — density first, then
silhouette, then colour, in that order of how much they matter at an isometric
distance — scattered in three bands:

- **Verge**, the strip beside the road. The only band on screen the whole time:
  the camera shows about thirty metres across and the embankment starts ten from
  the centreline. Grass in the forest, dune grass on the coast, heather on the
  moor, loose stone in the quarry, snow-covered rock in winter.
- **Bank**, the embankment itself, seen at the edges of the frame and through
  every corner that opens out.
- **Beyond the wall**, for the wide shots and for the sense that the road goes
  somewhere: dense conifers in the forest, spoil heaps and dead trees in the
  quarry, snow-laden firs thinning into open white, and no trees at all on the
  moor — that absence is the whole look of the place.

All of it is scenery in the strict sense: outside the corridor, nothing collides
with it, and nothing in `sim/` knows it exists. The things you can hit are the
stage's hazards, and those are data. It is scattered along the centreline rather
than over the stage's bounding box, because a stage is a ribbon through a
landscape and a bounding box puts nine tenths of the instances where the camera
never looks.

### The ground

A centreline says where a road goes and almost nothing about what it is. Left to
themselves the stages came out flat in both directions at once — level across,
level along except where a crest had been typed in — and a flat road takes the
same line at the same speed everywhere on it, which is the difference between
driving a stage and following one. Three things fix that, all of them in `sim/`
before the spline is built, so the collider, the AI, the camera and the props
all agree about where the ground is:

- **Elevation** from two long sine waves seeded off the stage's own id, applied
  at spline-sample resolution rather than at the control points — those are 30
  to 50 m apart, so a wave shaped there is sampled twice a cycle and arrives as
  a hint of a slope. Wavelengths of 150 and 75 m at 1.1 m of amplitude: measured,
  2.2 m at 96 m gave one-in-three slopes and put three quarters of one stage's
  AI lap off the road.
- **Camber** derived from the corner, and then modulated by a slow seeded wave
  so that some corners fall away from you instead. Both matter and the second
  matters more: a road that is always banked into the turn is a road that
  flatters you, and the corner that quietly drops off is the one rally drivers
  talk about. Authored banking always wins.
- **A crown** down the middle of the road, about one and a half percent, as
  every real road has because water has to run off it. It is why running wide
  costs a little more than the width does.

Both ends taper to flat: a grid on a slope, or a finish run-off tipping
downhill, is a car rolling off the end of the world.

`npm run stages` is the gate. All nine stages remain completable, none is above
a quarter of its lap off the road, and the AI's best lap is within a few percent
of what it was on seven of them and 6–20% faster on the other two, because
camber helps it hold the road. Medal times were left where they are; that makes
those two marginally more attainable and nothing harder.

One thing this broke and how: elevation moves every arc length slightly, which
moved the camera zones, and one zone on one stage crossed the line where the car
starts driving out of the screen rather than into it. The zone rule bounded how
far the road turns inside a zone, which is not the same as bounding how far the
road ends up from the camera it was given — the yaw is snapped to an eighth of a
turn and carries the isometric offset, and those stack. It had been passing by a
hair. The zones are now checked metre by metre after they are built and split
where they fail, so the property the tests check is the property the code
enforces.

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

### Multiplayer

Up to four cars in one world, hitting each other, over a connection with no
server behind it. Press **N**.

**Why the simulation being headless paid for this.** `src/sim/` never imported
three.js, so the host runs *literally the same code* as every client, and four
cars is a loop rather than a redesign: a car is a vehicle with its own damage
and its own attachment state, and being rammed by a player goes through the
identical impact path as hitting a rock. The damage model needed no changes at
all. Measured, a T-bone at 60 km/h costs the rammer its lights and the victim
31% of a door — the same numbers a crash into scenery produces, because it is
the same code.

**Host-authoritative, not lockstep.** Rapier is deterministic for a given build
on a given machine and not across machines or browser versions, so lockstep
would desync within seconds with no way to tell which copy was right. One player
runs the truth; everyone else predicts and is corrected.

**Prediction on your own car, interpolation on everyone else's.** Your car is
simulated locally from your own input with no waiting, and the authoritative
position is folded in as a correction spread over a quarter of a second — past
2.5 m or 0.7 rad the disagreement is too large to have come from timing, so it
snaps instead. Other cars are played back 0.1 s behind the newest snapshot,
which covers a lost packet from the buffer instead of showing as a stutter.
They stay real rigid bodies with real velocities, so you can still hit them.

Measured over twenty seconds at 80 ms round trip: your car ends within 4 m of
where the host has it, reached by blending rather than teleporting, and it holds
under 20% packet loss. Other cars run 0.16 s behind — the interpolation delay
plus the latency plus half a snapshot interval, with nothing unaccounted for.

**A guest's own car is index 0 in its own world.** The whole game above the
simulation — camera, HUD, damage panel, rescue — is written around the local car
being the first one, so a guest swaps its car with car zero and undoes the swap
at the wire. The grid takes the same permutation, so both copies of the race
line up identically with nobody spawning on pole and being dragged sideways by
the first snapshot.

**No server, and no bill.** The game is static files on GitHub Pages, so the
players are the signalling channel: the host makes an invite code, sends it
however they already talk, and pastes back the reply. Two data channels — one
ordered and reliable for the lobby, one unordered with no retransmits for inputs
and snapshots, because a late input is worse than a lost one.

```bash
npm run netcheck   # two real browsers, one race, over a real data channel
```

That check drives the lobby through its own DOM and then verifies that what one
page drives, the other one sees: 27.7 m driven, 27.6 m seen.

**What is not built.** Standings and finish order are exchanged but not shown on
the HUD; there is no rejoin after a disconnect (a dropped player's car coasts,
and the race carries on); and only the host's economy is authoritative for its
own run — everyone settles their own race locally.

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
- **P8 — Conditions** ✅ time of day and weather as per-stage variants, each with
  its own record, ghost, medals and payout; grip and visibility both affected;
  headlights that scale with the `lights` component, which until now had a
  repair cost and no gameplay effect whatsoever.
- **P9 — Brakes** ✅ per-corner disc temperature in real units, fade you can
  measure, glowing discs — and the tyre-model fix that made threshold braking
  worth doing at all.
- **P10 — Consequences** ✅ parts that drag and then leave as collidable debris,
  landings that cost a suspension when they land badly, and an honest answer on
  two-wheel balance.
- **P11 — Wildlife** ✅ deer that are always seen before they move, plus a
  bounded random tier of gusts and stone strikes.

- **P12 — Multiplayer** ✅ four cars in one world, host-authoritative netcode
  with prediction and interpolation, WebRTC data channels with no server, and a
  lobby that connects two players by copy-pasting two codes.
