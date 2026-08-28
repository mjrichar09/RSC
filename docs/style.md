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

## What carries style in every direction

Worth doing whichever way the plan goes:

1. **Car identity.** Liveries, numbers, a choice of two or three body shapes.
   The car is on screen for the entire game and is currently anonymous. The
   panels are already separate meshes, so a livery is a texture atlas and a
   number plate is a decal.
2. **A colour grade per time of day.** Dawn is not day with the lights on. One
   LUT-ish curve in the existing composite pass, keyed off `Conditions`, would
   do more for the look than any amount of geometry.
3. **Typography with a point of view.** The HUD is legible and anonymous. A
   condensed face for numbers, a stencil for stage names, or period-correct
   Letraset — a font is the cheapest personality available.
4. **Sound.** Already synthesised and already good; what is missing is *place* —
   birds in the forest, wind on the moor, water on the coast, the hollow quiet of
   snow. Ambience is where a stage becomes a country.
5. **Spectators and marshals.** Half a dozen instanced figures at the corners
   that a stage's crowd actually gathers at. Nothing says "this is an event"
   faster, and they are the same instanced scatter the vegetation uses.
6. **A replay and a photo mode.** The ghost system already records a run. Free
   camera, slow motion, and a still with the grade on it — and every screenshot
   a player posts is marketing.

## Cheap wins, ranked

By what they buy per hour spent, best first:

| Idea | Size | What it buys |
| --- | --- | --- |
| Colour grade per time of day | S | Dawn, dusk and night stop being the same picture at different brightness |
| Ambient sound per biome | S | Place, immediately, for no geometry |
| Livery + number on the car | S/M | The car becomes *your* car |
| Marshals and spectators at corners | M | It becomes an event rather than an empty road |
| Skid/rut colour per surface (done) | — | Already in |
| Outline pass | M | The whole screen-print direction, and it makes damage read better |
| Depth of field | M | The whole diorama direction |
| Film grade + grain | M | The whole Group B direction |
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
