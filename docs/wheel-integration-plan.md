# Plan: a stable wheel step, and the clutch it turns out to need

Status: **not started**. Written 2026-09-26 at the end of the session that
found the problem. The fix is in `docs/wheel-integration.patch`; applying it
alone is a regression (see "Why it was not landed").

## The report

"The steep descent on Coldwater Pass is still causing strange behaviour. It is
very hard to keep the car from fishtailing even at slow speeds when not going
perfectly straight."

## What was measured

**The wheels fight each other below about 70 km/h.** Cruising straight at a
steady 36 km/h on flat tarmac, one rear wheel was driving at +15% slip while
its neighbour braked at −8%, and every tyre was spending 70–99% of its friction
circle on that. Cornering gets what is left.

The cause is the explicit Euler step on wheel spin in `sim/vehicle.ts` (the
tire pass, `w.spin += ((driveTorque - reaction) / WHEEL_INERTIA) * dt`). Slip
ratio is divided by road speed, so the tyre's grip on the wheel stiffens as the
car slows. At 36 km/h the wheel's time constant is about 2 ms, against an
8.3 ms step, so every step overshoots equilibrium and the wheel settles into a
limit cycle instead of onto the balance point. Bisected by raising
`WHEEL_INERTIA` from 1.2 to 6 for one run: cruise saturation went from ~0.9 to
0.06 on the flat and 0.14 on the descent.

**The descent amplifies it through `tireGripBalance`.** On the flat the rear
carries more load than the front (≈3000 N vs 2650 N per wheel), which offsets
the rear's 0.88× grip against the front's 1.12×. On the 22% descent the load
moves forward (rear ≈2300 N, front ≈2850 N) and the rear keeps its grip
penalty, so it runs nearer its limit (saturation 0.88 vs 0.81 in the same
steering tap). The same 0.6 s full-lock key tap at 55 km/h peaks at 5.4° of
drift on the descent against 2.8° on the flat.

## Why it was not landed

The patch removes the chatter (cruise uses 2–10% of grip on the flat, 12–15%
on the descent, both wheels on an axle agreeing). But **the car's launch was
built on the instability.**

There is no clutch: engine rpm is derived from the driven wheels' spin
(`vehicle.ts`, `rawRpm = |avgSpin × ratio × finalDrive|`, floored at idle). On
the old code, a standing start threw the wheels past the tyre's peak (145% slip
at 0.5 s), which took the engine to 3 900 rpm and its torque band. With a stable
step the tyres simply grip, the engine sits at 1 000 rpm and bogs.

Measured with the patch applied (numbers before → after):

| | before | after |
|---|---|---|
| 0–100 km/h (`launch`) | 4.27 s | 5.27 s |
| top speed in the `launch` trace | 154.9 km/h | 146.3 km/h |
| `sweep` speed at 0.15 lock | 92.5 km/h | 59.1 km/h |
| `sweep` balance at 0.15–0.50 lock | understeer | mild oversteer |
| `stages` | all 14 finish | all 14 finish, 0.1–1.9% slower |

`npm test`: 6 failures, all green on the original code —

- `handling.test.ts` › lets a provoked slide be caught with opposite lock (7.6, wants > 10)
- `handling.test.ts` › does not spin all the way round under a normal handbrake pull (179°, wants < 150)
- `handling.test.ts` › gives less grip and less speed as the surface gets looser
- `handling.test.ts` › makes loose surfaces slide more under the same cornering input
- `consequences.test.ts` › a terminal failure › stops the engine but leaves the car rolling
- `net.test.ts` › stops teleporting the car on a poor connection (5, wants < 5; possibly chaos, check it first)

## The plan

Each step ends with `npm test`, and with `npm run stages` where noted. Keep
`tools/`-style probes in the scratchpad, not the repo.

### 1. Baseline, on the machine of the day

Record before anything changes, because `perf` and timing move under load:

```bash
npm run telemetry -- --trace=launch,brake,slalom,handbrake,catch,circle,drift,stops > before-tel.txt
npm run sweep > before-sweep.txt
npm run stages > before-stages.txt
```

### 2. Apply the wheel step

```bash
git apply docs/wheel-integration.patch
```

Re-run a straight cruise at 36 km/h and confirm per-wheel saturation is in the
single digits and both wheels on an axle agree. That is the property the whole
change exists for. Consider a test for it in `tests/handling.test.ts`: cruise at
a fixed speed and assert mean saturation < 0.2 and |sr_left − sr_right| small.
It would have caught this bug, and nothing did.

### 3. A clutch, so the engine can rev off the line

The smallest model that restores a launch without faking one:

- Engine rpm becomes its own state, not a function of the wheels. It is
  coupled to the driveline through a clutch that is **slipping** below a
  closing speed (say ~15 km/h in first, or whenever wheel-side rpm < a
  launch rpm) and **locked** above it.
- While slipping: engine rpm is pulled toward a launch target by throttle
  (rev up freely, bounded by the torque curve and an engine inertia), and the
  torque delivered to the driveline is the clutch's transmitted torque —
  engine torque at the *engine's* rpm, capped by a clutch capacity. While
  locked: exactly today's behaviour.
- New numbers go in `data/tuning.ts` with the units in their doc comment:
  `clutchLockSpeed` or `launchRpm`, `clutchCapacity`, `engineInertia`.
- Reverse and the stall model in `damage.ts` both read `engineRpm`, so check
  them. A stalled engine must still read 0.

Calibrate against the `launch` trace: target 0–100 in about 4.3 s so medal
times survive. Accept a launch that now needs some wheelspin management over
one that is free, if that is how it drives. Decide from the seat, then record
the number.

### 4. Handbrake and slides

With the chatter gone the rear holds more lateral grip at low slip, and the
handbrake rotation went to 179°. Expect to move, in this order, each A/B'd with
`--set=` rather than edits:

- `handbrakeGripLoss` / `handbrakeTorque` against the handbrake test and
  `--trace=handbrake`
- `slideGripFloor` against `--trace=drift` and `--trace=catch`. Its comment
  says it was set "from the seat" and its numbers were measured on the
  chattering car, so they need retaking either way.
- The two surface tests, which may just need the new ordering re-measured
  rather than a retune.

Every comment in `tuning.ts` that quotes a trace figure (`maxSteerAngle`,
`peakSlipAngle`, `slideGripFloor`, `brakeTorque`, `tireGrip`) was measured on
the chattering car. Retake each figure and correct it in place.

### 5. Revisit `tireGripBalance` only after 2–4

Once the chatter is gone, re-measure the descent tap at 35 and 55 km/h. If the
descent still feels loose, `tireGripBalance` 1.12 is the lever: it is what
makes forward weight transfer oversteery. It moves every handling number, so it
comes last.

### 6. Stages, medals, commit

`npm run stages` against `before-stages.txt`. If the AI's times move by more
than a couple of percent, rebase the medal tables per CLAUDE.md (scale each
stage's table by its own before/after ratio). Grand Traverse night-snow is the
canary.

Commit message: lead with the cruise saturation measurement (70–99% → single
digits) and the launch finding. The "a model tuned on its own artifact" lesson
belongs in CLAUDE.md under *Simulation, determinism and units*.

## Also found, not acted on

- **Centre diff sign on the overrun.** `distributeTorque` shifts a *share* of
  `axleTorque` toward the slower axle. On power that is right; with negative
  (engine-braking) torque it hands the slower, locking axle *more* braking. The
  axle LSD does not have this bug (it moves an absolute torque). A/B'd on an
  engine-braking coast down the descent it made no measurable difference, so it
  was not changed. Fix it as `shift × |axleTorque|` if engine braking or the
  clutch in step 3 makes it matter.
- **The rear locks first under braking.** From 45% pedal, flat and descent,
  stepped input; `brakeBias` 0.62 dates from the scaffold commit and was never
  calibrated. Moving it to 0.70–0.82 did not change the fishtail measurements,
  so it is not the cause, but a stop that locks the rear first is unstable by
  construction. Re-measure after step 2. Count lock only above ~4 m/s: the
  slip-ratio denominator clamps at 1 m/s and every wheel reads locked at
  walking pace.
