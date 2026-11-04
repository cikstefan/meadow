# Meadow

A procedural, GPU-driven meadow for the browser: over a million wind-swept grass
blades plus wildflowers, generated and culled every frame on the GPU with
**WebGPU compute shaders** and **indirect draws** (three.js r187, TSL).

Inspired by Ming Jyun Hung's write-up
[*False Earth: From WebGL Limits to a WebGPU-Driven World*](https://tympanus.net/codrops/2026/04/21/false-earth-from-webgl-limits-to-a-webgpu-driven-world/)
(Codrops) and its [open-source code](https://github.com/momentchan/false-earth).
The techniques are reimplemented here from scratch for an open meadow scene.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

![Golden hour](docs/golden-hour.png)
![Midday](docs/midday.png)

<sub>Screenshots from a software (SwiftShader) renderer at the *medium/low* preset.</sub>

Needs a browser with WebGPU: Chrome / Edge 113+, Safari 26+, Firefox 141+ (Windows).

**Controls:** move the mouse to look (the view follows the cursor; drag also works) · WASD / arrows to move · Shift to run · wheel or Q/E for height (first person) or camera distance (third person) · **V** toggles first person / third person following the jaguar · M toggles sound.
Auto tour (the camera wandering on its own) is off by default; enable it in the panel or with `?tour=1`.

**URL options:** `?q=low|medium|high|ultra` (disables adaptive quality),
`?hour=4.55`, `?grass=1.71`, `?winddir=108`, `?dry=0`, `?clouds=0.35`, `?wind=0.55`, `?bloom=0`, `?tour=0`, `?sound=0`, `?nogui`.

## How the grass works

| Stage | What happens |
| --- | --- |
| **Slots** | An N×N grid of blade slots (up to 1664² ≈ 2.8M) is centred on the camera. It acts as a *toroidal window* over an infinite global lattice: slot `i` always holds the unique global cell ≡ `i (mod N)` inside the window. |
| **Lazy rebuild** | Each slot stores which global cell it holds. When the camera moves, only the rows and columns that wrap around rebuild their *static* data: jittered position, terrain height and normal, Voronoi clump, height, width, bend, yaw and dryness. Everything else is reused, so per-frame cost doesn't depend on how far you walk. |
| **Per-frame compute** | For every slot: radius test, sphere-vs-frustum test in clip space. Visible blades sample the travelling gust field, cloud shadow and walker push once (not per vertex), then `atomicAdd` themselves into one of three LOD lists. |
| **Indirect draw** | Each LOD (12 / 5 / 2 segments) is one `drawIndexedIndirect`. The instance count comes from the atomic counter, so the CPU never reads anything back. |
| **Vertex shader** | Each blade is a cubic Bézier spine. Wind pushes the control points, a phase that travels with the gusts makes waves roll across the field, and per-blade flutter is added on top. The curve is renormalised so blades keep their length, and is clamped above the local ground plane. With distance, blades turn partly toward the camera and widen, so they don't shimmer into sub-pixel slivers. |
| **Shading** | A custom foliage model: wrapped diffuse, sky/ground ambient, **translucency** (backlit blades glow), a waxy specular sheen, height AO, drifting cloud shadows and aerial perspective. The normal blends toward the terrain normal with distance, so the canopy behaves like a volume. |

Meadow-scale variation comes from low-frequency fields shared by every system:
tall vs short grass, dry straw patches, and flower drifts. Within those,
Voronoi **clumps** (tussocks) vary blade height, width, bend and colour, and
blades lean outward from each clump centre.

### Grass to the horizon
A second instance of the same system covers a ring out to ~180–220 m with a
coarse lattice of wide, low-segment blades. It fades in exactly where the dense
near field fades out, so real waving blades reach the hills. A large-scale
octave in the gust field plus a gust-driven *sheen* (bent blades show their
lighter faces) on blades and on the distant canopy makes wind waves readable
across the whole valley.

### Night
Below −4° the directional light is handed to a cool moon on the opposite side of
the sky (no pop, since the sun contributes nothing by then). The sky gets a hashed
star field with twinkle, a faint Milky Way band, and a deep-blue palette with blue
ambient light. Flowers become bioluminescent: their petals and centres emit blue
light (with bloom), and grass and terrain in flower drifts receive that light.
Pollen turns into slowly pulsing blue spores.

### The jaguar
Model: [“jaguar” by Ear.Rodriguez](https://sketchfab.com/3d-models/jaguar-91c61c329d2a4668816f81f08dfcd492),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It was converted from FBX to glTF
(meshopt + WebP, 7.2 MB → 1.2 MB, shipped as a lazily loaded chunk) and **repainted melanistic**: the
coat texture is baked to near-black, with the rosettes kept as a slightly darker pattern so they show
faintly in the light, as on a real black jaguar. ~1.8x real size.

- **Coat:** matte fur (high roughness, low specular, a soft dull sheen) plus fine fur strands lifted
  from the deer's coat, applied triplanar in bind space; a faint fur halo when backlit.
- **Eyes:** shaded procedurally around each eye bone's gaze axis: a silver-blue iris with radial
  fibres, a dark limbal ring and a round black pupil that widens at night. A wet cornea, no glow.
- **Motion: real animation clips from a tiger, retargeted.** The motion comes from
  [“Tiger” by planeta-elefante](https://sketchfab.com/3d-models/tiger-5566ab23dc004b3b96f3c15c7276e681)
  (CC BY 4.0). Its Walk, Run (a bounding gallop with flight phases), lie down, get up, sleep and
  attack clips are baked onto the jaguar's Advanced Skeleton rig at load (`src/retarget.js`):
  - each tiger bone's rotation change from its standing pose is applied to the matching jaguar bone,
    with both skeletons in one shared body frame
  - the tiger's 3-bone spine and 4-bone tail are spread over the jaguar's 5-bone spine and
    10-bone tail
  - root motion is scaled by the ratio of the two cats' leg lengths
- **Blending by speed:** idle, walk and run share one stride phase. Each clip plays at the rate
  that makes its planted paws move exactly as fast as the body (stance speed is measured from the
  clip itself), so the feet don't slide. Walk is 1.5 m/s, run (Shift) 8 m/s and sprint
  (Shift+Space) 11.5 m/s; **F** attacks with a lunge or a paw swipe.
- **Foot contact:** a thin 2-bone IK pass lifts any paw the clip would push below the terrain.
  The tiger's legs are proportioned differently, and the meadow isn't flat.
- **Rest:** while standing, the jaguar model's own idle clip plays (looking around, sniffing,
  pawing), with ear and tail flicks. After 10 s it **lies down**; after 25 s it **puts its head down
  and sleeps**. Moving wakes it, and it gets up before walking off.
- Footfalls drive soft paw-step audio. The body parts the grass and casts a soft shadow.
- In first person the jaguar wanders around you on its own. In third person you steer it
  camera-relative; **R** toggles always-run, **F** attacks, and the status line shows its gait.

### More characters: velociraptor and human
**V** cycles the view: first person → jaguar → raptor → human. Each character loads the first
time it's chosen and appears a few metres ahead. When you switch away it stays in the meadow,
idling, and goes to sleep after a while. Both run on one shared controller, `src/character.js`,
which works like the jaguar's:
- in-place locomotion clips share one stride phase, and each plays at the rate that matches its
  feet to the ground
- one-shot actions play over the base layer; any forward root motion in a clip (a leap, a tackle)
  is stripped from the skeleton and turned into real movement
- a rest loop takes over after standing still

- **Velociraptor:** [“PBR Velociraptor (Animated)” by ferociousindustries.matthias](https://sketchfab.com/3d-models/pbr-velociraptor-animated-8f1744af7b0847a2aabe3df90be802f0),
  CC BY 4.0. It uses its own 26 clips; the materials were converted from spec-gloss to metal-rough
  (WebP + meshopt, 16.6 MB → 2.8 MB).
  - **Moving:** walk, jog, sprint (Shift, up to 6.5 m/s); the clips play faster than authored,
    with stride rate rising with speed.
  - **Actions:** **Space** leaps (6 m of root motion), **F** bites or tackles, **G** roars.
  - **Idle and rest:** idle variations (sniff, call, look around); sleeps after 15 s.
  - The deer treat it as a predator.
- **Human:** [“Low Poly Female” by Loves_Art](https://sketchfab.com/3d-models/low-poly-female-07eeb124d210402bbc061e543d0b97a1),
  CC BY 4.0, animated with **Mixamo** motion clips retargeted onto her rig at load. The
  retargeter first lines the two rest poses up bone by bone (T-pose vs A-pose), then transfers
  the rotation changes.
  - **Moving:** walk, run (Shift); **C** crouches and crouch-walks.
  - **Actions:** **Space** jumps, keeping your momentum; **F** kicks or punches.
  - **Rest:** lies down to sleep after 20 s.

### The red deer
Model: [“Deer (Demo Free Download)” by All For $19.99](https://sketchfab.com/3d-models/deer-demo-free-download-034f40010b1341e5bc352fd97c5254d6),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); converted from spec-gloss to
metal-rough, WebP + meshopt (10 MB → 0.88 MB). A herd of four: a stag and three hinds (females, no antlers):
- base layer: the artist's 22.5 s idle clip (ears, blinks, weight shifts), faded to a neutral
  stance while moving and out of the neck while grazing or alert
- procedural walk / trot / gallop on the 80-bone rig, speed-blended, no-slip stride
- behaviours: graze (head in the grass, chewing), look around, wander with the herd; **alert**
  (head high, ears forward, watching the threat) when the jaguar or you come near; **flee** at a
  gallop with a raised tail when they come closer (sooner if the jaguar is running); calm down after
- each deer parts the grass and casts a soft shadow, like the jaguar
- at night the stag's antlers glow blue-white in the moonlight, like the flowers

### Wildflowers
They use the same slot, compute, LOD and indirect pipeline with a sparser lattice.
Each flower is a single parametric mesh whose vertices are tagged as stem, petal
or centre. The vertex shader bends the stem like a blade and builds the head on
top, tilted toward the sun. Petal count, length, width and cupping depend on the
species: oxeye daisy, buttercup, poppy, cornflower or campion. Outlines (notches,
frills, rounded tips) are alpha-tested.

### The rest of the scene
- **Terrain:** an analytic value-noise height field, identical on CPU and GPU (the
  integer hash is bit-exact in JS), so the camera walks on exactly what is rendered.
  Its non-uniform grid follows the camera. Inside the grass radius it shows soil and
  thatch; outside it takes on the canopy's colour, texture and view-dependent
  darkening, so the edge of the grass is hard to spot.
- **Sky and fog:** both come from one radiance function, so the horizon has no
  seam. The sky adds a procedural cumulus layer and an HDR sun disk. A time-of-day
  palette drives all lighting.
- **Pollen:** a few thousand specks drift with the wind and sparkle only when
  backlit. They have no buffers; each position is a pure function of hash and time.
- **Post:** MSAA, bloom, ACES tone mapping, vignette.
- **Sound (Web Audio, fully synthesized, no audio files):**
  - *Music:* generative ambient in D major. Slow, lush pad chords (detuned
    sine/triangle voices through a slowly opening filter) and sparse soft
    mallet/bell notes drawn from the current chord, all in a long generated
    convolution reverb.
  - *Wind:* a low rumble, a moving whoosh and an airy grass-shimmer hiss. Their
    levels follow the exact gust field that bends the grass (a CPU mirror of the
    shader), sampled slightly upwind so you hear a gust roll in before it reaches you.
  - *Wildlife:* birds (whistle phrases, trills, two-note calls) by day with a dawn
    chorus, and crickets toward evening.
  - *You:* footsteps synced to the head bob (a soft soil thump, a "hush" of crushed
    grass and a cluster of crisp crunch grains), plus a continuous swish of legs
    through the grass that pulses with your stride and gets louder in tall grass
    and when running.
  - Sound starts on your first click or key press, as browsers require.

## ✦ Sword of the Sea mode (prototype)
An homage to Giant Squid's flowing worlds (Abzû, Sword of the Sea), in its own GUI folder,
all off by default (`?spirits=1&shafts=1&grade=1` turns everything on):
- **wind spirits:** ~170 luminous ribbons riding the wind over the meadow. Fully analytic:
  each follows a closed-form flight path (wind drift, weave, ripple, occasional loops,
  terrain-hugging height); its tail is the same path sampled at earlier times, rebuilt in the
  vertex shader. Warm filaments by day, rose-gold at dusk, bioluminescent blue at night.
- **sun shafts:** sky pixels near the sun radially blurred toward it, so grass blades and
  animals cut rays into the light (strongest with a low sun).
- **painterly grade:** richer saturation, cool shadows and warm highlights.

## Performance notes
- Storage buffers are packed (interleaved static data, one shared indirect-args
  buffer and one shared visible-index buffer per system), so each pass stays well
  under WebGPU's 8-storage-buffers-per-stage default limit.
- Draw order: near LODs first, then flowers, terrain and sky last. Covered terrain
  and sky pixels are rejected by early-z.
- Quality presets change blade count, grass radius, flower density, LOD distances
  and pixel-ratio cap. Without `?q=`, the app measures frame rate during the first
  seconds and steps quality down (or up) on its own.

## Files
```
src/main.js       renderer, post, GUI, adaptive quality, frame loop
src/grass.js      blade slots, compute pass, LOD routing, blade material
src/flowers.js    wildflower system
src/terrain.js    ground mesh + distant canopy shading
src/sky.js        sky dome, clouds, time-of-day palette
src/pollen.js     floating pollen
src/audio.js      procedural music, wind, wildlife, footsteps
src/controls.js   walk / look / auto-tour camera
src/jaguar.js     jaguar: materials, clip blending, rest states, foot IK
src/retarget.js   bakes clips from one skeleton onto another (tiger → jaguar, Mixamo → human)
src/character.js  clip-driven third-person character (raptor, human)
src/characters.js their configs and credits
src/gpu.js        storage + indirect-draw helpers
src/tsl/noise.js  bit-exact GPU/CPU hash + value noise
src/tsl/world.js  terrain, fields, wind, clouds, sky, fog, foliage lighting
```
