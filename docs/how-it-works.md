---
title: How WebGL Ripper works
description: The capture engine of WebGL Ripper in detail — WebGL hooks, frame recording, matrix and texture heuristics, texture readback, cleanup, streaming GLB/OBJ export, the preview, pick mode, performance and privacy.
lang: en
---

# How WebGL Ripper works

**English** · [Русский](how-it-works.ru.md) · [WebGL Ripper on GitHub](https://github.com/int3re/WebGLRipper#readme)

WebGL Ripper doesn't download model files from a server. A page can load a model in any format, from anywhere, or
generate it in code — what every WebGL page has in common is that, in the end, it hands vertex buffers, textures and
shaders to WebGL and calls `drawArrays` / `drawElements`. The extension listens at exactly that point: it records one
frame as the GPU sees it and turns every draw call back into a mesh.

```
 page scripts ──► WebGL API ──► GPU
                     │
           hooks (webglripper.js, in the page)
                     │  one recorded frame
                     ▼
     draw calls ─► cleanup ─► preview (viewer.js) ─► GLB / OBJ + MTL + PNG ─► download
```

1. [Where the code runs](#where-the-code-runs)
2. [Hooks that are always on](#hooks-that-are-always-on)
3. [Recording a frame](#recording-a-frame)
4. [What is read for every draw call](#what-is-read-for-every-draw-call)
5. [Finding the real model: cleanup](#finding-the-real-model-cleanup)
6. [Textures](#textures)
7. [The preview](#the-preview)
8. [Pick mode](#pick-mode)
9. [Export: GLB, OBJ and ZIP](#export-glb-obj-and-zip)
10. [Performance](#performance)
11. [Privacy and safety](#privacy-and-safety)
12. [Known limits](#known-limits)

## Where the code runs

| File | Runs in | Job |
| --- | --- | --- |
| `webglripper.js` | the page (`MAIN` world), at `document_start`, every frame | hooks, capture, cleanup, export |
| `viewer.js` | the page, in a closed shadow root | the preview and the pick hint |
| `settings.js`, `bridge.js` | the extension's isolated content script world | settings, hotkeys, progress, messages |
| `background.js` | service worker (Chrome) / background script (Firefox) | toolbar badge, browser shortcuts, sends commands to every frame of the tab |
| `popup.*`, `options.*` | extension pages | buttons and settings |

The engine has to be in the page's own JavaScript world: that's the only place where `WebGLRenderingContext` can be
wrapped for the page. Manifest V3 lets an extension declare such a script with `"world": "MAIN"` and
`"run_at": "document_start"`, so it runs **before the first script of the page** — the original version injected a
`<script>` tag at runtime, which loads asynchronously and missed every context created while the page was loading.

The engine and the extension talk through DOM events on `document` with JSON strings (`webglripper:page` for commands,
`webglripper:ext` for status). The bridge reads settings from `chrome.storage.sync` and passes them with every command,
so changes apply at once, without reloading the page.

Everything the engine needs from the page's environment (`requestAnimationFrame`, `Blob`, `CompressionStream`,
`JSON`, DOM methods…) is saved when it starts, so a page that later replaces these functions can't break or observe
the export.

## Hooks that are always on

Some facts can't be asked from WebGL later, so a handful of functions are wrapped from the start:

- `getContext` — to know every WebGL context (also on `OffscreenCanvas`).
- `texImage2D`, `texStorage2D`, `compressedTexImage2D`, `copyTexImage2D` — WebGL can't tell the size or format of a
  texture, so they are noted when it is uploaded. The original version only knew the size of textures uploaded from
  an image or canvas and assumed 4096×4096 for the rest (raw data, `texStorage2D`, compressed).
- `getUniformLocation`, `getExtension` — to map location and extension objects back to their names and contexts.
- `framebufferTexture2D` — to know which textures are render targets (and of which framebuffer).
- WebGL 1 only: `bufferData`, `bufferSubData`, `deleteBuffer`. WebGL 1 can't read a buffer back, so its contents are
  copied as they are uploaded. These are real copies: Unity and other Emscripten apps upload views into one big heap
  that they overwrite right after the call (the original kept a reference to that view and later read garbage).

Every wrapper is a `Proxy` around the native function: the page sees the same `name`, `length` and
`toString()` ("`[native code]`"), the call itself goes straight to the browser, and the extension's own work runs
after it, inside `try/catch`, so an error in the extension can never reach the page's draw loop.

**Draw calls are not hooked at this point** (see [Performance](#performance)).

## Recording a frame

When you press the hotkey, the engine waits for the next `requestAnimationFrame`, then installs the capture hooks for
exactly one frame:

- every draw call: `drawArrays`, `drawElements`, `drawRangeElements`, the instanced variants (WebGL 2 and
  `ANGLE_instanced_arrays`) and `WEBGL_multi_draw`;
- uniform setters (`uniform*`, `uniformMatrix*`), so matrices and colors are known without a slow `getUniform`
  round trip for every draw;
- `vertexAttribDivisor` (per-instance attributes aren't vertex data), uniform buffer bindings (`bindBufferBase`,
  `bindBufferRange`, `uniformBlockBinding`) for engines that keep matrices in UBOs;
- `blitFramebuffer` and WebGL 2 buffer uploads (to drop stale cached copies).

The frame is recorded from its first draw call until it ends; if the page didn't draw anything (scenes that only
redraw on change), the engine keeps waiting for a frame that does, up to 15 seconds. Then the hooks are removed and
the export runs. The original version started and stopped on `gl.clear()`, so pages that don't clear never finished.

## What is read for every draw call

**State comes from WebGL itself**, not from a copy kept by the extension: the current program, the attribute
bindings (`VERTEX_ATTRIB_ARRAY_*`, which includes vertex array objects), the index buffer, the framebuffer and the
viewport. The original tracked `vertexAttribPointer` calls itself and ignored VAOs, so on WebGL 2 engines such as
three.js it could combine the wrong buffers.

**Which attribute is what.** The program's active attributes are named by the page, so a name heuristic decides
which one is the position, normal, UV and color: exact names from many engines (`position`, `a_position`,
`in_POSITION0`, `_glesVertex`, `s_attribute_0`…) first, then a token match (`aVertexPosition` → *vertex, position*),
with obvious non-geometry (morph targets, skinning weights, instance offsets, tangents) rejected. Unknown engines can
be taught extra names in the options.

**Vertex data** is read only for the vertices the draw call uses: from the WebGL 1 copies, or on WebGL 2 straight from
the GPU with `getBufferSubData` (each buffer once per capture). Every vertex format is decoded: floats, normalized and
integer bytes/shorts, half floats, packed `INT_2_10_10_10_REV` normals, any stride and offset. Strips and fans become
triangles, honouring WebGL 2 primitive restart and dropping degenerate triangles.

**Placement.** Engines put the model matrix in the shader under many names (`modelMatrix`, `u_world`,
`unity_ObjectToWorld`, `uMVMatrix`…). The engine classifies matrix uniforms into *model*, *model-view* and *view*,
reads them (from the recorded setters, a UBO, or `getUniform` as a last resort) and:

- applies a model matrix directly;
- for a model-view matrix, finds the camera — the view matrix most draw calls of the context share — and removes it;
- if no camera can be found, keeps the mesh in its own coordinates rather than export it in camera space.

**Materials.** Samplers are mapped to texture units and the textures bound there, then classified by name: base color
(`map`, `_MainTex`, `baseColorTexture`, `u_texture`…), normal, emissive, roughness, metalness, occlusion, and things
that are not material textures at all (shadow maps, environment maps, LUTs, previous frames) which are skipped.
Color uniforms (`diffuse`, `u_color`, `_Color`, `baseColorFactor`…) become the material color — but not the color of a
light (`directionalLights[0].color`). Blending and face culling decide transparency and `doubleSided`.

## Finding the real model: cleanup

A frame contains a lot that isn't the model. In this order:

1. **Viewer overlays** are dropped:
   - draws into a viewport smaller than a quarter of the largest one drawn into the same target (axis gizmos,
     minimaps);
   - full-screen passes — a triangle or quad covering clip space that samples a texture the page rendered itself or is
     drawn without depth testing (post-processing, outlines, gradient backgrounds);
   - helpers drawn on top of a scene that otherwise uses depth testing (move and rotate gizmos, handles, labels), with
     the copies other passes draw of them.
2. **The same geometry drawn more than once** (shadow maps, depth pre-passes, reflections). For every geometry the copy
   drawn into the render target **closest to the screen** is kept. The engine builds a graph of which framebuffer
   feeds which — a pass that samples a render-target texture or blits a framebuffer links them — and walks it from
   the canvas: the scene target feeding the post-processing chain wins over a shadow map that only feeds the scene.
   Ties go to the busier target, then the one drawn last; untextured copies of textured geometry are dropped too.
3. **Transforms** are applied (see above), vertex colors are normalized, plain white colors dropped.
4. **Welding.** Pages often draw without an index buffer, every triangle with its own three vertices, which would
   import as thousands of loose triangles. Identical vertices (same position, normal, UV and color) are merged with a
   hash table — the icosahedron of the test scene goes from 240 to 42 vertices.
5. **Normals.** Meshes drawn without normals get smooth ones: face normals are averaged around each position, but only
   between faces less than 60° apart, so hard edges stay hard.
6. **Backgrounds.** Meshes made of positions only that are drawn from the inside or enclose everything else (sky
   domes, environment shells) are kept but not selected: the preview shows them with a *background* badge, and
   without the preview they aren't downloaded.
7. **Centering.** Optionally the whole export is moved so it stands on the origin.

## Textures

Textures are read back from the GPU at their real size, in bands of about 4 MB:

- color-renderable textures are attached to a framebuffer of the extension's own and read with `readPixels`;
- compressed (S3TC/DXT…), float, half-float, luminance and other formats that can't be attached are first drawn into
  an RGBA8 target with a small shader, then read the same way.

The page's GL state — bindings, active texture, pixel store settings, viewport, the texture's own sampling
parameters — is saved and restored around every read, and the test suite checks that the page's state is identical
before and after a capture.

Each texture is encoded as a PNG once and shared by the preview, the GLB and the OBJ files. The encoder streams: a band
is read, filtered and compressed while the next one is read, so a 4K texture never sits in memory as a whole. Opaque
textures are stored as RGB, others as RGBA with their exact color under transparent pixels (`canvas.toDataURL`, which
the original used, premultiplies alpha and destroys it). Every row uses the PNG "Up" filter: measured on a real 4K
texture it compresses as well as or better than Paeth and lets deflate finish about a third faster.

With the preview on, only base color textures are read before it opens — that is what it shows. The other maps are
read after you press Download, and only for the meshes you chose.

## The preview

`viewer.js` draws the captured meshes in an overlay on the page: its own WebGL 2 canvas in a **closed shadow root**,
styled with a constructed stylesheet and built without `innerHTML`, so the page's CSS, scripts, Trusted Types or CSP
can't affect it, and the engine ignores the preview's own WebGL context.

- Orbit, pan and zoom with the mouse; double-click frames a mesh.
- Clicking a mesh toggles it: the click is resolved by rendering mesh IDs into an offscreen buffer and reading the
  pixel under the cursor. Excluded meshes stay visible as transparent ghosts.
- Each base color texture is decoded once, straight at preview size (at most 2048 px), even when many meshes share it;
  only a 68 px copy is kept for the list. Colors are shown as a glTF importer shows them (linear factors, sRGB
  textures).
- Fullscreen and pointer lock are released when it opens, so it can't end up hidden behind a fullscreen game.

## Pick mode

Pick mode answers the question "which draw call drew *this* pixel?":

1. The next click on a WebGL canvas is intercepted, so the page doesn't react to it, and its position on the canvas
   is remembered.
2. The next frame is captured as usual, but after every draw call the engine reads the pixel at that position in the
   framebuffer the draw went to (render targets are mapped through their viewport, float targets are read as floats,
   multisampled ones are skipped). A draw call that **changed** the pixel is a hit.
3. The last hit in the render target closest to the screen is the visible object — this works through
   post-processing, because the scene is drawn into a render target before it reaches the canvas.

Only the picked mesh is exported (or pre-selected in the preview).

## Export: GLB, OBJ and ZIP

**GLB** (glTF 2.0 binary) has one node and mesh per captured mesh with `POSITION`, `NORMAL`, `TEXCOORD_0`
(flipped to glTF's convention) and `COLOR_0`, 16- or 32-bit indices, PBR materials (base color, normal, emissive,
occlusion, and metal/roughness when the page samples them from one texture, as glTF expects) and the PNGs embedded. It
is assembled from `Blob` parts, so geometry and textures aren't copied into one big buffer.

**OBJ** indexes positions, UVs and normals separately; writing each distinct value once keeps meshes connected
across UV seams and hard edges in Blender. Text is generated in 1 MB pieces. Materials go into one MTL file with
`Kd`, `Ke`, `d` and texture maps.

**ZIP** files are compressed while they are written (`CompressionStream('deflate-raw')`, CRC-32 computed 16 bytes at a
time), PNGs are stored as they are, and small files are gathered into 8 MB blocks before they are handed to the
browser as Blobs (which can be paged out to disk), instead of one Blob per file.

The download is a `blob:` URL clicked on a hidden link. During long steps the export pauses every ~30 ms with a
message-channel tick, so the page keeps rendering; timers aren't used for this because browsers throttle them in
background tabs.

## Performance

| | What is done |
| --- | --- |
| Normal browsing | Only the always-on hooks listed above; no per-draw-call cost at all. A WebGL 2 scene with 3000 draw calls per frame renders as fast as without the extension. |
| During the recorded frame | Program reflection is cached per program, uniform values come from the recorded setters, GPU buffers are read once per capture, divisors and UBO bindings come from hooks instead of `getParameter` round trips. |
| Export | Everything streams in pieces of 1–8 MB; textures are read in 4 MB bands; welding uses a hash table with a proper finalizer (round coordinates — integer grids, voxels, CAD — don't collide); PNG uses the Up filter; ZIP checksums use slicing-by-16; the page gets a frame every ~30 ms. |
| Preview | Only base color textures before it opens, decoded once at preview size; GPU picking. |

See the [comparison with the original](comparison.md) for measured numbers.

## Privacy and safety

- **No network.** The extension makes no requests at all; captures never leave your computer.
- **Permissions:** `storage` (settings) and access to pages (to run the engine in them). Nothing else.
- **No remote code.** Everything runs from the files in the package.
- **The page isn't changed.** Hooks never throw into the page, GL state is restored after every read, and the preview
  is isolated from the page's scripts and styles.

## Known limits

- Characters skinned on the GPU are saved in their bind pose; morph targets aren't applied (the vertex shader moves
  the vertices, the extension saves what the page uploaded).
- WebGL running in a Web Worker (`OffscreenCanvas` transferred to a worker) is out of reach of a page script.
- Instanced draws export one copy of the instanced geometry; `WEBGL_multi_draw` batches have no per-object matrices.
- Name heuristics can miss unusual engines; Options → Advanced takes extra names, and `rip-info.json` lists the names a
  page uses.
