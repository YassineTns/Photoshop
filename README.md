# Halftone Studio

A Photoshop UXP plugin for bitmapping artwork, with two rendering engines:

- **Halftone** — a regular grid of dots whose size follows local luminance and
  whose colour comes from a quantised palette.
- **Dither** — 24 dithering algorithms (Bayer, clustered, blue noise, and ten
  error-diffusion kernels) that pick one palette colour per pixel.

Both are computed by the plugin's own engine, not by a stack of Photoshop
adjustment layers, and both can output either a flat pixel layer or a
**colour-separated stack of editable fill layers**.

![Comic preset — halftone mode](docs/sample-comic.png)
![Zone Poster preset — dither mode with tonal zones](docs/sample-dither.png)

---

## Install

You need **Photoshop 24.0 or newer** (the imaging API the plugin reads and
writes pixels with landed in 23.3; 24.0 is the floor declared in the manifest)
and the [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/),
which installs from the Creative Cloud Desktop app.

1. `git clone https://github.com/YassineTns/Photoshop.git halftone-studio`
2. Open **UXP Developer Tool**, press **Add Plugin**, select `manifest.json`.
3. Press **Load**. The panel appears under **Plugins ▸ Halftone Studio**.
4. While developing, **Watch** reloads the panel whenever a file changes.

There is no build step and no dependencies. The plugin is plain CommonJS modules
loaded directly by UXP, so what you edit is what runs. `npm install` is only
needed if you want to run the tests.

## Use

1. Select a pixel or Smart Object layer.
2. Press **Load Layer**. The panel reads the pixels and shows a live preview.
3. Pick a **Mode**, adjust anything. The preview follows every slider in real time.
4. Press **Apply**. The plugin builds:

```
Halftone ▸ HT-4f2a9c        ← group, carries the parameters
   ├── Halftone Render       ← the generated pixels (flat output)
   └── Halftone Source       ← your original, as a hidden Smart Object
```

or, with **Output: separated**:

```
Halftone ▸ HT-4f2a9c
   ├── Ink 3 #EC3E32         ← solid-colour fill layer + coverage mask
   ├── Ink 2 #161616         ← "
   ├── Ink 1 #8A7F6C         ← "
   ├── Paper #F5EBD8         ← "
   └── Halftone Source
```

5. Later, select that group and press **Load Layer**: every slider is restored
   from the stored parameters. Change what you like and press **Update** — the
   render is recomputed from the untouched source.

Slider conventions: drag to scrub, hold **Shift** for fine control, **double
click** (or the ↺ button) to restore the default, and type in the numeric field
for an exact value.

---

## Architecture

```
manifest.json          UXP manifest (v5)
index.html             panel markup
src/
  main.js              bootstrap
  engine/              the renderers - pure JS, zero UXP dependencies
    color.js           sRGB/linear, OKLab, HSL, luma
    blur.js            3-pass box blur approximating a Gaussian
    preprocess.js      unsharp mask, edge-preserving noise reduction
    grade.js           tone LUT, Schlick bias, ink -> radius
    quantization.js    median cut, k-means, popularity
    palette.js         extraction, spread, matching, ink/paper split
    tonemap.js         shadow / midtone / highlight palette bands
    shapes.js          dot shapes as signed distance functions
    resample.js        area-average downscaling
    halftone.js        grid, cell sampling, antialiased rasteriser, separation
    dither.js          threshold matrices, diffusion kernels, dither pass
    pipeline.js        staged cache, mode dispatch, async chunked rendering
  photoshop/           everything that touches the host
    host.js            module access, executeAsModal, capability probing
    document.js        document + selection queries (read only)
    layers.js          layer ops (DOM first, batchPlay fallback), fill layers
    imaging.js         getPixels / putPixels / putLayerMask
    metadata.js        parameter persistence
    render.js          Apply / Update orchestration, output modes
  ui/
    panel.js           panel controller
    controls.js        sliders, segmented pickers, chips, toggles, palette
    styles.css
  state/params.js      the parameter schema - single source of truth
  presets/presets.js   the eleven built-in presets
  util/                PNG encoder, UTF-8 base64
test/                  engine suite + mocked-host integration suite
tools/make-icons.js
```

`src/state/params.js` is the spine: the UI builds itself from it (including
which controls are visible in which mode), presets are validated against it, and
persisted records migrate through it. Adding a control means adding one entry
there.

### The two pipelines

```
                       source pixels
                             │
              area-average downscale to an "analysis" image
                             │
          denoise → blur → sharpen  (resolution-independent units)
                             │
              ┌──────────────┴───────────────┐
      HALFTONE│                              │DITHER
              │                              │
  assign every pixel to a grid       apply the tone LUT per channel
  cell, accumulate tone + colour              │
              │                        for each pixel: nearest palette
   per cell:  grade → ink → bias         entry, then either a threshold
   radius = maxRadius·√ink               matrix or error diffusion
              │                              │
  rasterise dots at output size     nearest-neighbour scale to output
```

Two decisions do most of the work.

**In halftone mode, only two operations touch pixels and neither runs at
document resolution.** Cell tone is a low-frequency measurement, so measuring it
on a downscaled image is very nearly identical — the cell sampler performs the
same area average the downscaler already did. Everything downstream operates on
the cell array. Dragging a slider never re-reads a source pixel.

**In dither mode, the grid itself is the parameter.** Dithering decides a colour
per pixel, so it cannot be reduced to cell averages. Instead it runs on a grid of
"dither pixels" whose count you set, then scales up with nearest-neighbour. That
is what gives the chunky bitmap look, what DPI-based scaling means in practice,
and it keeps the cost proportional to the grid rather than the document.

In both modes the expensive stage is cached and keyed, so **slider latency is
flat in document size** — 6 to 14 ms whether the document is 1080px or 6000px.

### Dithering

24 algorithms in three families:

| Family | Algorithms |
|---|---|
| Ordered | Bayer 2/4/8/16, Clustered 4/6/8/45°, Line H/V/45°, Blue Noise, White Noise |
| Diffusion | Floyd–Steinberg, False F–S, Jarvis, Stucki, Atkinson, Burkes, Sierra 3/2/Lite, Stevenson–Arce |
| None | Threshold |

Two details matter more than the list length.

**Ordered dithering picks the best two-colour mix, not a perturbed nearest
match.** The obvious implementation — add the threshold matrix to the pixel, then
match in OKLab — does not reproduce the right average, because the perturbation
is linear in sRGB while the decision boundary sits wherever OKLab puts it. A
black-to-white ramp came out measurably light (0.84 ink where 0.94 was wanted)
and ordered dithering disagreed with error diffusion about exposure. Instead the
engine finds the nearest entry A, the entry B whose segment towards A best
contains the pixel, and the ratio *t* along it; emitting B for a fraction *t* of
pixels makes the average exactly the best two-colour approximation. Both families
now agree on tone.

**Thresholds sit at the centre of their bin.** A matrix with L levels can only
represent tone in steps of 1/L; centring halves the worst-case error from 1/L to
1/(2L) for free. It measurably improved every ordered algorithm (Bayer 2×2:
0.188 → 0.063 worst-case ramp error; the line screens: 0.063 → 0.001).

Blue noise is generated with void-and-cluster (Ulichney) at panel start, cached
after the first build (~40 ms). Unlike Bayer it has no low-frequency energy, so
it produces no visible grid — just an even, organic sparkle.

Atkinson deliberately discards 25% of its error; that is what produces the
blown-out early-Macintosh look, and the test suite exempts it by name rather than
loosening the tolerance for everyone.

### Halftone dot quality

- **Antialiasing** is analytic: each shape is a signed distance function and
  coverage is `clamp(0.5 − sdf, 0, 1)`. No supersampling, so no memory blow-up.
- **Sub-pixel dots** (radius < 0.5px) splat their exact analytic area bilinearly
  onto four pixels. Without this the highlight end of a gradient clamps to a
  fixed half-covered pixel and the ramp visibly stops being smooth.
- **Dot area is proportional to tone** (radius ∝ √ink), which is how a real
  amplitude-modulated screen behaves.
- **Shapes are area-matched** to within 4%, so switching shape changes the
  texture without changing the exposure.
- **The paper colour is never used as a dot colour.** If it were, every cell
  lighter than the mid point would draw an invisible paper-coloured dot and half
  the tonal range would disappear.

### Colour

Quantisation and matching happen in **OKLab**, which is why palettes stay clean
instead of muddy. `kmeans` is the default: seeded by median cut (so it is
deterministic) and it respawns dead centroids, so it always returns the number of
colours you asked for. On the flat-colour fixture it recovers all five source
colours exactly, where median cut lands within ΔE 0.13.

**Tonal zones** split the palette into shadow / midtone / highlight bands and
restrict matching to the band a pixel's luminance falls in. The palette is
already sorted dark to light, so each band owns a contiguous slice of indices —
which makes this an index range, not a per-pixel subset search. Bands overlap by
one entry: without that, error diffusion cannot carry error across a boundary and
the boundary shows up as a hard contour.

`Spread` pushes palette entries away from their centroid in OKLab, expanding
lightness harder than chroma. Hue/Saturation/Brightness are applied to the
palette rather than per pixel — for these pointwise HSL operations that is
equivalent, and it keeps Hue at O(colours) in both modes.

---

## Non-destructive design, and one thing UXP cannot do

**Photoshop does not let a plugin register its own Smart Filter.** The filter
list is closed to UXP and there is no API to install a re-editable filter entry
on a Smart Object. A "double-click the filter to reopen the dialog" experience is
therefore not achievable, and this plugin does not pretend it is.

What it does instead:

- your original pixels are **never modified** — they are sealed inside a Smart
  Object that stays in the document;
- the render lives on **its own layer(s)**;
- the parameters **ride along with the layer**, so selecting an old render
  restores every slider.

### Output modes

**flat** writes one pixel layer holding the composite. Update writes back into
the same layer, so any mask, opacity or blend mode you added survives.

**separated** writes one solid-colour fill layer per palette colour, each
carrying a mask with that colour's coverage. This is the better output for print
and for editing: double-click a fill layer to change that ink everywhere at once,
and the layers resample cleanly because only the mask is raster.

The masks are **mutually exclusive and sum to full coverage**, produced by
performing ordinary alpha compositing per channel (`mask_i = mask_i(1−a) + 255a`,
`mask_j *= (1−a)`). That means the stack reproduces the flat render *exactly*
and is independent of layer order — which matters, because dots of different
colours overlap and layer order would otherwise decide the result. The test suite
asserts both properties (worst deviation from full coverage: 0; worst channel
error against the flat render: 0.8/255).

Separation needs `imaging.putLayerMask`. Where that is missing the plugin falls
back to flat output and says so, rather than building half a layer stack.

### Where the parameters are stored

UXP exposes no "custom data" bag on a layer, so there is no single blessed place.
The plugin writes the same record to three places and reads them back in order of
reliability:

| # | Where | Travels in the .psd | Notes |
|---|-------|---------------------|-------|
| 1 | Layer XMP (`metadata`/`layerXMP` via batchPlay) | yes | Genuinely attached to the layer. An Action Manager property rather than a documented UXP surface, so **every write is verified by reading it straight back**; on mismatch the plugin downgrades to (2) and says so. |
| 2 | `halftone-renders.json` in the plugin's data folder | no | Always written. Keyed by render id, so it survives reopening — but only on this machine. |
| 3 | The render id in the group name (`Halftone ▸ HT-4f2a9c`) | yes | The locator that ties a selected layer back to (1) and (2). **Do not rename the group.** |

---

## Parameters

Units are chosen so that nothing depends on document resolution.

| Section | Parameter | Range | Meaning |
|---|---|---|---|
| Mode | Mode | halftone / dither | Which engine renders |
| Scale | Scale by | relative / dpi | DPI derives the grid from the document's own resolution |
| | DPI | 5–300 | Target output density (DPI mode) |
| | Density | 8–400 | Halftone cells across the longest edge |
| | Resolution | 24–2400 | Dither pixels across the longest edge |
| | Angle | 0–90° | Screen angle (halftone) |
| Halftone | Radius | 0–200% | Max dot size as a % of the cell half-size; >100% overlaps |
| | Dot Curve | 0–1 | 0 = area tracks tone (classic), 1 = radius tracks tone |
| | Shape | circle, square, diamond, cross, line | |
| Dither | Algorithm | 24 options | See the table above |
| | Amount | 0–1 | 0 posterises with no pattern; 1 is the full dither |
| | Serpentine | on/off | Alternate scan direction; cancels diffusion artefacts |
| Pre-process | Blur | 0–40 | px per 1000px of the longest edge |
| | Sharpen | 0–200% | Unsharp mask |
| | Sharpen R | 0.3–10 | Unsharp radius |
| | Noise Red. | 0–100 | Edge-preserving smoothing |
| Colors | Colors | 2–8 | Palette size |
| | Spread | 0–1 | Palette separation in OKLab |
| | Method | kmeans, mediancut, popularity | Quantisation algorithm |
| | Palette | hex list | Click to type, alt-click for the foreground colour |
| | Lock palette | on/off | Off re-extracts from the image on every render |
| | Background | auto or hex | Paper colour (halftone) |
| Tonal Zones | Tonal zones | on/off | Restrict each tonal band to its own palette slice |
| | Shadows / Highlights | 0.05–0.95 | Band boundaries |
| Grade | Contrast / Gamma / Black / White / Exposure | | Standard grading chain |
| | Grade Bias | −1…1 | Bends tone → dot size; endpoints stay pinned |
| | Luma | luma709, luma601, perceptual | How tone is measured |
| Adjust | Hue / Saturation / Brightness / Invert | | |
| Output | Output | flat / separated | One pixel layer, or one fill layer per colour |

**Presets.** Halftone: Classic B&W, Soft Print, Comic, Newspaper, RGB Pop, Retro
Poster. Dither: Mac Classic, Newsprint Dither, Handheld Green, Blue Noise, Zone
Poster. Save your own with **Save Preset**.

---

## Tests

```bash
npm test              # engine (253 assertions) + mocked host (129 assertions)
npm run test:visual   # also writes PNGs to test/out/ for eyeballing
npm run test:heavy    # adds the 6000x4000 case
```

The engine suite covers a black image, a white image, a **black→white gradient**
(radii strictly monotonic, dot *area* advancing in equal steps to within 6%, ink
present in all ten bands, the sub-pixel path exercised), flat colours, a
synthetic photograph, all five shapes, transparency, all eleven presets, screen
angles, resolution independence, cache invalidation and byte-level determinism.

For dithering it asserts **tone reproduction against a derived bound**: an
ordered matrix with L distinct thresholds can only represent tone in steps of
1/L, so the tolerance is 1/(2L), not a guessed constant. That checks each matrix
achieves the best it structurally can, instead of hiding a regression behind a
loose number. Threshold and Atkinson are exempted by name, with the reason.

The integration suite runs the Photoshop and UI layers against a mocked host. It
cannot prove the batchPlay descriptors are accepted by Photoshop — only Photoshop
can — but it does prove the plugin's own logic: layer structure and ordering, the
original never being written to, mask writes reaching every fill layer, the
documented fallback when masks are unavailable, parameters round-tripping through
XMP *and* the sidecar, and that every parameter in the schema is reachable in
some UI state and no control is built for a hidden one.

### Measured performance

Synthetic photograph, Node 22 (Photoshop will differ, but the ratios hold):

| Mode | Document | First preview | Slider re-render | Full render |
|---|---|---|---|---|
| Halftone | 1080×1080 | 41 ms | 14 ms | 32 ms |
| Halftone | 1920×1080 | 32 ms | 9 ms | 49 ms |
| Halftone | 3000×3000 | 86 ms | 14 ms | 192 ms |
| Halftone | 6000×4000 | 149 ms | 10 ms | 973 ms |
| Dither | 1080×1080 | 49 ms | 5 ms | 14 ms |
| Dither | 1920×1080 | 36 ms | 3 ms | 25 ms |
| Dither | 3000×3000 | 99 ms | 7 ms | 119 ms |
| Dither | 6000×4000 | 155 ms | 6 ms | 798 ms |

Slider latency is flat in document size. Full renders are chunked with yields so
Photoshop's UI keeps breathing, and reads from Photoshop are capped at 2600px on
the longest edge while the render is still written at full resolution.

---

## Known limitations

1. **Not a real Smart Filter.** Explained above. Update is a button.
2. **No batch or video render.** There is no "apply across all layers or frames"
   mode; each render is one layer at a time.
3. **Layer XMP is not a documented UXP API.** Every write is verified by
   readback, with a sidecar fallback, so the worst case is that parameters do not
   travel to another machine inside the .psd.
4. **RGB documents only.** CMYK, Lab, Indexed and Duotone are not converted.
5. **Dither previews above 700 dither-pixels are approximate.** The preview
   caps the grid so dragging stays responsive, and the badge says `approx` when
   it does. Apply and Update always render the full grid. Halftone previews are
   always exact.
6. **Colour management is assumed sRGB.**
7. **The plugin does not watch the Smart Object.** Edit its contents, then press
   Update.
8. **Renaming the halftone group** breaks the sidecar lookup. The layer XMP still
   works if it took.

## Roadmap

Ordered by how much each would improve fidelity:

1. **Per-channel screens with independent angles.** Real CMYK halftones give each
   ink its own angle (15°/75°/0°/45°) to produce a rosette instead of a moiré.
   The renderer is already generic over grids and the separated output already
   produces per-ink masks, so this means running the grid once per ink.
2. **Batch render across layers and video frames**, the main remaining feature
   gap against comparable commercial plugins.
3. **Dot gain / spot function shaping**: a configurable transfer curve on the ink
   amount, plus elliptical dots that merge along one axis first.
4. **Per-swatch locking** so extraction can refresh some palette colours while
   preserving others, plus `.ase` / `.act` import and export.
5. **Edge-aware cell sampling**, weighting the cell average towards the dominant
   region so dots stop straddling hard edges.
6. **A C++ or WASM rasteriser.** Only the rasteriser is worth moving — the
   analysis stage is already negligible. The current JS path holds ~1 s for
   6000×4000, so this is an optimisation, not a necessity; the staged interface
   (`_ensureCells`/`_ensureDither` → `rasterize`) is where a native module slots
   in without touching anything else.
