# Style: where this could go

Notes for the polish plan. Nothing here is built; it is a menu with prices on it,
written now so the plan session can argue about direction rather than about
options.

## What the game looks like today

An honest inventory, because half of these are decisions and half are just what
happened first:

- **Flat-shaded primitives.** Boxes and cones, one material each, hard normals.
  The car is fourteen bolt-on panels because it has to lose them, not for looks.
- **Fixed isometric camera** that pans and zooms but never rotates, with yaw
  derived per zone from the road. Everything about legibility follows from this.
- **One key light** on the opposite azimuth from the camera, a hemisphere fill,
  and a shadow frustum that rides with the car.
- **Colour by function**: the nose is the bright accent so heading reads at a
  glance; rivals are told apart by hue; surfaces carry their own colour and the
  spray is drawn from it.
- **A post pass** that darkens and blurs outside the headlight cone, and puts
  weather on the windscreen.
- **UI**: one monospaced face, amber accent, translucent slabs, wide letter
  spacing. Consistent, and about as characterful as a spreadsheet.

The strongest thing about it is that everything on screen means something. The
weakest is that it has no point of view: it looks like a competent prototype of
a game rather than a game.

## Three directions, as packages

These are alternatives, not a menu to pick from at random. Each is a coherent
whole; mixing two gives the current situation with more work.

### A. Diorama

The world as a beautifully made model. Lean all the way into the fixed camera:
tilt-shift depth of field, soft contact shadows, slightly exaggerated scale on
the car, saturated but controlled palette, a visible "table edge" where the
terrain falls away into a soft void rather than fog.

- **Buys**: instant identity, and it flatters what is already there — flat
  shading reads as painted wood rather than as untextured geometry.
- **Costs**: a real depth-of-field pass (the existing blur target is half-res and
  already paid for, so this is cheaper than it sounds), plus a lighting pass to
  get shadows soft and warm.
- **Risk**: miniature worlds read as gentle. This is a game about breaking a car.

### B. Group B, on film

1985. Warm film grade, grain that tracks exposure, gate weave on the replay,
period liveries with sponsor decals, hand-painted-looking corner boards, dust
haze in the low sun, wooden spectator barriers and yellow-jacketed marshals.

- **Buys**: enormous character for very little geometry — most of it is grade,
  signage and props. It also gives the damage model its natural home: those cars
  arrived at the finish looking like this.
- **Costs**: a grade/grain pass (cheap), a decal system on the car (medium), and
  a props library (medium, but it is the same instanced scatter that already
  dresses the biomes).
- **Risk**: grain and vignette fight legibility on a small screen. Needs a
  strength slider from the start, like the windscreen effect has.

### C. Screen print

A poster, not a photograph. Three or four flat colours per stage, thick dark
outlines on the car and the road edge, halftone or hatched shading, no gradients
at all. The kind of thing that would look right on a rally programme cover.

- **Buys**: it reads at any zoom and on any screen, it is nearly free to render,
  and it makes the biome palettes do the heavy lifting they are already set up
  for.
- **Costs**: an outline pass (edge detection on depth+normal, one full-screen
  pass), a palette quantiser, and a pass over every colour in the game.
- **Risk**: it hides damage. Dents read through shading, and a flat-colour world
  has none — it would need outlines that thicken and break where metal is folded.

## What carries style in every direction — built

These did not need the direction decided first, so they are in. What is left
below them is the part that does.

1. **Car identity** ✅ — six liveries, each a set of three colours with an accent
   that keeps the nose reading as the front, plus a competition number on the
   roof (the panel a fixed isometric camera sees most) and on both doors. Picked
   beside the garage turntable so the car changes as you press. *Not done: body
   shape variants, which touch the damage model's panel layout, the debris parts
   and the turntable, and are a class-structure decision rather than a visual
   one.*
2. **A colour grade per time of day** ✅ — lift, gain, contrast, saturation and
   vignette per time of day, with weather layered on top, riding in the pass the
   game already runs for the windscreen. Dawn is cold in the shadows and low in
   contrast; night is blue and nearly colourless; fog is almost all lift.
3. **Typography** ✅ *as a system* — display, figure and UI roles, one size
   scale, tabular figures wherever a number changes under load. The actual face
   is still open, and is now a one-line change.
4. **Sound of the place** ✅ — wind by biome and weather, surf on a swell for the
   coast, rain and snowfall hiss, and synthesised birdsong in daylight when the
   car is not shouting over it. It ducks with speed and keeps breathing quietly
   behind a menu.
5. **Spectators and marshals** ✅ — crowds on the outside of the corners,
   weighted by pacenote severity so a hairpin draws a knot of people and a kink
   draws nobody, and marshals either side of every gate.
6. **Replay and photo mode** ✅ — `P`, mid-run or after. Scrub, slow to an
   eighth, turn the camera in eighths of a turn, zoom, hide the chrome, save a
   PNG.

## Cheap wins, ranked

By what they buy per hour spent, best first:

| Idea | Size | What it buys |
| --- | --- | --- |
| ~~Colour grade per time of day~~ | S | ✅ in |
| ~~Ambient sound per biome~~ | S | ✅ in |
| ~~Livery + number on the car~~ | S/M | ✅ in |
| ~~Marshals and spectators at corners~~ | M | ✅ in |
| ~~Replay and photo mode~~ | M | ✅ in |
| Outline pass | M | The whole screen-print direction, and it makes damage read better |
| Depth of field | M | The whole diorama direction |
| Film grain over the existing grade | S/M | Most of the Group B direction, now that the grade is in |
| Period signage, barriers and marshal props | M | Where a stage stops being a biome and becomes a country |
| Car body variants | L | Class structure, and a reason to buy one |
| Weather on the road surface (wet sheen, ruts filling) | L | Rain stops being a filter and becomes a surface |

## Open questions for the plan session

1. **Which package**, or a fourth? My vote is B with a slider, because it is the
   only one that makes the damage model — the best thing in the game — look like
   what it is.
2. **How much is the car allowed to change?** Liveries and numbers are cheap;
   multiple body shapes touch the damage model's panel layout, the debris parts
   and the garage turntable.
3. **Does the camera ever move?** A replay camera that rotates would be the first
   break in a rule that has held since the first commit, and everything about
   legibility depends on it. Worth breaking only for replays.
4. **How far does biome identity go?** Signage and architecture (Alpine
   guardrails, Nordic snow poles, Mediterranean stone walls) are what make a
   stage read as a country. That is a props library, and it is a lot of props.
5. **What is the strength slider for style?** The windscreen effect has one and
   it was the right call. Grain, outlines and depth of field all want the same
   treatment, and that is a UI decision as much as a rendering one.

## What not to do

- **Do not lose the heading cue.** The bright nose is why you can read the car's
  direction while it is sideways in a cloud of gravel. Any restyle keeps it or
  replaces it with something equally instant.
- **Do not let the effect hide the damage.** The bodywork is a readout. It is why
  the vision pass cuts the car out of its own blur.
- **Do not texture the road so heavily that the surface stops reading.** Grip is
  colour-coded; a photographic gravel texture would look better and drive worse.
- **Do not add a second bright colour to the car.** Two bright ends make the
  heading ambiguous, which is the bug this palette was chosen to avoid.
