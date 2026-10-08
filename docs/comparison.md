---
title: WebGL Ripper vs. the original 0.6 — measured
description: Side-by-side measurements of WebGL Ripper and the original WebGL Ripper 0.6 by Rilshrink on the same pages — capture time, page freezes, memory, file size and whether the exported models are right.
lang: en
---

# WebGL Ripper vs. the original 0.6, measured

**English** · [Русский](comparison.ru.md) · [WebGL Ripper on GitHub](https://github.com/int3re/WebGLRipper#readme)

This project started as a fix-up of [WebGL Ripper 0.6 by Rilshrink](https://github.com/Rilshrink/WebGLRipper) and
ended as a rewrite. To show what changed in practice, both versions were installed as real extensions in the same
browser and run on the same test pages. Nothing in the original was changed; it got its best settings.

## Summary

| | Original 0.6 | This version (1.1.2) |
| --- | --- | --- |
| three.js scene with shadows and post-processing | wrong: every mesh at the origin, no normals, the wrong texture on every mesh, saved 16× too large | right: every mesh in place, normals, colors, the real texture |
| Time to the file, three.js scene | 0.56–0.82 s | 0.17 s (GLB), 0.24–0.42 s (OBJ ZIP) |
| Page freeze during the export, three.js scene | 385–585 ms | 41–80 ms |
| 3000 draw calls | no file after 3 minutes, page frozen, +1.3 GB | 0.28 s (GLB) / 0.6–0.8 s (OBJ ZIP), +42–78 MB |
| 250 000 vertices, two 4096² textures | 3.9 s, 1.5 s freeze, +816 MB, 60 MB ZIP, misplaced | 1.6 s (GLB) / 2.7 s, under 0.2 s freeze, +177–253 MB, 5.6 MB ZIP, in place |
| Unity / Emscripten-style buffers | garbage | exact |
| WebGL context created while the page loads | not captured (3 of 7 test pages) | captured |
| Pages that never call `gl.clear()` | never finish | captured |
| Frame time, 3000 draw calls, not capturing | +0.36–0.53 ms (≈2× the frame) | ±0.1 ms (noise) |
| Frame time, 2000 WebGL 1 buffer uploads | +0.85–1.1 ms | +0.5–1.1 ms |

## Method

- **Machine:** Windows 10, Chrome 154 in headless mode, one fresh browser profile per version.
- **Install:** each version loaded with *Load unpacked*, exactly as a user installs it. The original: WebGL Ripper 0.6
  from the Rilshrink repository. This version: the release package built from this repository.
- **Settings**, so that both produce the same kind of file — one ZIP with OBJ files:
  - original: *Download as ZIP* on, debug logging off, *Use Model View Matrix* on (its best settings; a fresh install
    of the original has debug logging **on**);
  - this version: preview off, format OBJ, *Move to the origin* off (so positions can be compared), ZIP on. GLB times
    are measured separately with the default format.
- **Trigger:** a real <kbd>Insert</kbd> key press sent through the browser's input pipeline.
- **Time** is measured from the key press to the moment the browser reports the download as complete.
- **Page freeze** is the longest gap between two animation frames of the page while the export runs.
- **Memory** is the growth of the private memory of the page's renderer process and of the GPU process over the value
  just before the key press, sampled every ~100 ms. A run is stopped if the system runs short of memory.
- **Frame time** is the trimmed mean of 290 frames (the slowest and fastest 10 % dropped), timer resolution 0.1 ms,
  three runs per configuration.
- **Correctness:** every download is opened, each object's vertex count and center are computed and compared with
  where the object really is in the scene, and texture sizes are read from the PNG headers.

Absolute times depend on the machine; the relation between the two versions is what matters. The scenes and the
script are in [`tests/compare/`](https://github.com/int3re/WebGLRipper/tree/main/tests/compare), see
[Reproduce](#reproduce).

## Test pages

| Page | What it is | Why |
| --- | --- | --- |
| `three.html` | three.js r170: a textured cube, a torus knot, an icosahedron and a floor; shadows on every mesh, `EffectComposer` post-processing, a `ViewHelper` axis gizmo | a typical modern viewer |
| `bench.html` | WebGL 2: 3000 small textured draw calls per frame from one shared buffer, 8 textures; WebGL 1: N `bufferSubData` calls per frame | many objects; cost per frame |
| `heavy-late.html` | one mesh of 250 000 vertices moved to (1, 2, 3) by its model matrix, two 4096×4096 textures | a big model like a photogrammetry or AI-generated one |
| `heap-late.html` | WebGL 1, buffers uploaded as views into one big heap that is overwritten right after | how Unity and Emscripten apps upload data |
| `early.html`, `heap.html`, `heavy.html` | the context is created while the page is still loading | the timing of the extension's own startup |

The `-late` pages create their WebGL context half a second after the page has loaded. The original injects its code
asynchronously and misses contexts created earlier; the late variants make sure it is measured on what it *can*
capture.

## Results

### Frame time when nothing is being captured

What the extension costs a page all the time, just by being installed.

| Scene | No extension | Original 0.6 | This version |
| --- | --- | --- | --- |
| 3000 draw calls per frame (WebGL 2) | 0.40–0.62 ms | 0.88–1.00 ms | 0.39–0.71 ms |
| 2000 buffer uploads per frame (WebGL 1) | 0.70–0.78 ms | 1.55–1.83 ms | 1.22–1.79 ms |

The original wraps 24 WebGL functions on every context and keeps its own copy of the GL state in JavaScript, so every
draw call, bind and pointer call pays for it. This version hooks draw calls only while a frame is recorded; the
remaining cost is the copy that WebGL 1 uploads need (WebGL 1 can't read buffers back).

### three.js scene

| Object (where it really is) | Original 0.6 | This version |
| --- | --- | --- |
| Textured cube at (−2, 0.7, 0) | 24 vertices at (0, 0, 0) | 8 vertices at (−2, 0.7, 0), with normals |
| Torus knot at (0.4, 1.2, 0) | 4025 vertices at (0.1, 0, 0) | 3840 vertices at (0.42, 1.2, −0.02), with normals |
| Icosahedron at (2.6, 0.8, −0.5) | 240 loose vertices at (0, 0, 0) | 42 welded vertices at (2.6, 0.8, −0.5), with normals |
| Floor, 12 × 12 at the origin | standing upright (12 × 12 × 0) | lying flat (12 × 0 × 12) |
| Normals | none | yes |
| Material colors | none | `Kd` / `baseColorFactor` from the shader |
| Texture | the cube's 256×256 checker saved as 4096×4096, assigned to all 4 meshes | 256×256, only on the cube |
| File | 0.95 MB ZIP | 0.13 MB ZIP / 0.14 MB GLB |
| Time / longest frame | 0.56–0.82 s / 385–585 ms | 0.24–0.42 s (OBJ), 0.17 s (GLB) / 41–80 ms |

The original records from one `gl.clear()` to the next. In this scene that is, by all signs, the shadow-map pass
(depth-only draws without normals): no transform it recognizes was applied, so every object ended up at the origin,
and the texture is whatever was still bound. This version records the whole frame and keeps the pass that reaches the
screen.

### 3000 draw calls

| | Original 0.6 | This version |
| --- | --- | --- |
| Result | no file after 3 minutes; the page stopped responding | 3000 meshes in place, 8 textures |
| Time | — | 0.28 s (GLB), 0.62–0.76 s (OBJ ZIP, 3011 files) |
| Longest frame | the page stopped responding | 68–112 ms |
| Extra memory | +1335 MB (+197 MB GPU) | +42–78 MB |

For every draw call the original lists all active uniforms of the program twice and reads matrices and samplers with
`getUniform` — synchronous round trips to the GPU process — and it reads every texture at the guessed size of
4096×4096 through a 2D canvas. Without `gl.clear()` in the frame it doesn't finish at all.

### A big model: 250 000 vertices, two 4K textures

| | Original 0.6 | This version |
| --- | --- | --- |
| Result | right vertex count, but at (0, 0, 0) instead of (1, 2, 3) | in place at (1, 2, 3) |
| Time | 3.9 s | 1.6 s (GLB), 2.7 s (OBJ ZIP) |
| Longest frame | 1539 ms | 134–186 ms |
| Extra memory | +590 MB (+226 MB GPU) | +169–245 MB (+8 MB GPU) |
| File | 60 MB ZIP (stored, uncompressed) | 5.6 MB ZIP / 14 MB GLB |

When the same page created its context while loading (`heavy.html`), the original captured nothing.

### Unity / Emscripten-style uploads

| | Original 0.6 | This version |
| --- | --- | --- |
| Context created after loading | a 1.1 MB OBJ with a single vertex at (3.4·10³⁸, 3.4·10³⁸, 3.4·10³⁸) | the quad, exact |
| Context created while loading | nothing | the quad, exact |

The original keeps a reference to the uploaded view instead of a copy; by the time it reads it, the heap has been
reused and holds other data (here the byte pattern `0x7F7F7F7F`, which is 3.4·10³⁸ as a float).

### A context created while the page loads

`early.html` creates its context in a `<script>` in the page's head — common for small demos and engine loaders. The
original's code arrives later, so it never sees this context: no file. This version runs before the page's scripts and
saves the triangle exactly.

## Everything else that differs

| | Original 0.6 | This version |
| --- | --- | --- |
| Formats | OBJ + MTL + PNG | GLB (glTF 2.0) and/or OBJ + MTL + PNG |
| Choosing what to save | — | 3D preview in the page |
| Saving one object | — | click it (pick mode) |
| Shadow passes, gizmos, post-processing, duplicates | saved if they are the recorded pass | removed |
| Vertex array objects (WebGL 2) | ignored | read from WebGL |
| Texture size | known only for image/canvas uploads, otherwise 4096×4096 | tracked for every upload path |
| Compressed, float, luminance textures | not readable | read through a draw pass |
| Color under transparent pixels | lost (`toDataURL` premultiplies) | kept, byte-exact PNG |
| Welding, missing normals | — | yes |
| Downloads | uncompressed ZIP, or one download per file with 0.5 s pauses | one compressed ZIP or one GLB, streamed |
| Settings reach the page | through a hidden `<div>` in the page | from extension storage, live |
| Toolbar button, status, shortcuts | Insert key only | badge, popup, configurable hotkeys, browser shortcuts |
| Firefox | install steps in its README | a Firefox 128+ package, tested |
| Tests | — | engine, three.js, large-export and extension end-to-end tests in Chrome and Firefox |

## Reproduce

You need Node.js 22+, Chrome, and the original extension unpacked into a folder.

```
node tests/compare/compare.mjs --original=<folder of WebGL Ripper 0.6>
node tests/compare/compare.mjs --original=<folder> --scenes=three,heavy-late --engines=orig,new,new-glb
```

The script builds the release package, starts a fresh headless Chrome for every version, prints one line per page and
leaves the downloads and a `results.json` in the system's temp folder (`webglripper-compare`). Memory is sampled on
Windows only. Heavy pages need a few GB of free memory; the script stops a run if the system gets short.
