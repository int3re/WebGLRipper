# Changelog

## 1.3.0

### Added

- **Straight into Blender.** A free Blender add-on (`blender/webglripper_blender.py`, Blender 3.6 or newer, tested
  with 4.5) watches the downloads folder and imports every new rip — GLB, STL, USDZ or an OBJ zip — as soon as the
  download is complete, into a collection of its own, selected and framed. A GLB's page camera becomes the scene camera when the scene has
  none. *Import latest rip* in the sidebar imports the newest file on demand.
- **Characters in their pose.** On WebGL 2 pages skinned and morphed meshes are saved the way they are on the screen
  instead of in the bind pose: the page's vertex shader runs once more with transform feedback and the moved vertices
  are read back (option *Characters in their current pose*, on by default).
- **The page's camera in GLB files**: a *Page camera* node with the page's view and lens, so Blender opens the same
  view (option *Include the page's camera*, on by default).
- **Smaller GLB** (option, off by default): `KHR_mesh_quantization` geometry and JPEG for opaque textures. Geometry
  takes about half the space; a model with a photo texture went from 760 KB to 136 KB.
- **STL** (binary, Z up, for 3D printing) and **USDZ** (for AR Quick Look on iPhone and iPad) formats, in the options
  and in the preview.
- **Turntable video:** <kbd>V</kbd> or *Video* in the preview records a 6-second 360° WebM of the selected meshes.
- **History of rips:** every rip with its thumbnails, site, numbers and file, newest first. *Show in folder* and
  *Open* find the download again; the last 50 rips are kept, only in this browser and never for private windows
  (option *Keep a history of rips*). Opened from *History* in the popup or the options.
- **Russian interface.** The popup, the options, the history, the preview, the pick hint and the status texts are in
  English or Russian, following the browser's language or chosen under *Interface → Language*. Store texts and
  keyboard shortcut names are localized too.

### Changed

- Text in the popup, the options and the history is no longer shrunk by Chrome's default `font-size: 75%` for
  extension pages: buttons and status texts were smaller than the captions next to them.
- The `downloads` permission is optional: it is asked for the first time *Show in folder* is used, so updating the
  extension doesn't need new permissions.

## 1.2.0

### Added

- **The popup shows what was found.** *On this page* lists the WebGL canvases of the tab (size, WebGL 1 or 2, also
  inside frames). After a rip, *Last rip* lists the saved objects with a thumbnail rendered from the mesh, its
  triangles, base color texture and size, and says what was left out and why: gizmo parts, corner helpers,
  full-screen passes, shadow and depth copies, backgrounds.
- **The preview list shows each mesh**: a rendered thumbnail of its shape with its texture or color instead of a flat
  swatch, and a second line with triangles, texture size and dimensions, so it is clear which mesh is which.

### Changed

- Status texts count properly ("Saved 1 mesh and 1 texture").

## 1.1.3

### Fixed

- Editor-style viewers (seen on studio.tripo3d.ai) exported their helpers together with the model: the move gizmo
  (arrows, cones, plane handles), the axis gizmo in the corner, a full-screen pass and a big background sphere, which
  also made the model look tiny in the preview. Now:
  - helpers drawn on top of the scene — without depth testing while the rest of the scene uses it — are left out,
    together with the copies other passes draw of them (outline and depth passes);
  - the axis gizmo is recognized again when the full-screen passes share one triangle: the largest viewport of a
    target is taken from every draw call, not only from the recorded ones;
  - full-screen passes are recognized by their geometry (a triangle or quad covering clip space), also when they
    sample an image texture besides the frame;
  - sky domes and other position-only shells around the scene are marked as *background*: the preview offers them
    unselected, and without the preview they aren't downloaded;
  - when the remaining meshes don't show the camera, it is taken from the other draws of the scene, so the model
    stays in its place.
- The preview's grid is sized to the selected meshes, not to a sky dome around them.
- `rip-info.json` lists the depth and face state of every mesh and whether it was taken for a background.

## 1.1.2

### Performance

- Draw calls are only hooked while a frame is being recorded. The rest of the time the extension costs pages nothing
  per draw call: a WebGL 2 scene with 3000 draw calls per frame renders as fast as without the extension (the
  original 0.6 made the same frame about twice as slow).

### Documentation

- README in English and Russian, a detailed description of how the extension works, and a measured comparison with
  the original WebGL Ripper 0.6 (`docs/`), with the scripts to repeat it (`tests/compare/`).
- A project website: https://int3re.github.io/WebGLRipper/ (English and Russian).

## 1.1.1

### Performance

- Welding vertices with round coordinates (integer grids, voxel and low-poly models, CAD) no longer stalls: the hash
  table let such vertices collide, a 540k vertex mesh took 38 s, now 0.1 s.
- The preview opens sooner: before it, only the base color textures are read; normal, roughness and other maps follow
  after the choice, and only for the meshes that are downloaded.
- PNG textures use the "Up" filter: measured on a real 4K texture, encoding is about 30 % faster and the file 6 %
  smaller.
- OBJ archives with many small files are written up to 3 times faster (files are gathered into large blocks instead
  of one browser Blob each), and ZIP checksums are computed 2.5 times faster.
- The page keeps rendering during an export: long steps pause every few dozen milliseconds. "GLB + OBJ" used to
  freeze it for seconds while the model was compressed.
- The preview decodes each texture once, straight at preview size, even when many meshes share it, and keeps only a
  small copy for the list.

## 1.1.0

### Added

- **GLB export** (now the default format): one `.glb` file with the meshes, embedded PNG textures and PBR materials
  (base color, normal, emissive, occlusion and metal/roughness maps, colors and transparency), ready for Blender,
  Unity, Unreal, Godot or Sketchfab. OBJ is still available, or both at once.
- **Preview before download**: after a capture the meshes are shown in a 3D view right in the page. Orbit, pan and
  zoom, click meshes (or use the list) to include or exclude them, pick the format, then download only what you
  chose. Excluded meshes stay visible as ghosts.
- **Pick an object**: press Shift+Insert (or "Pick object" in the toolbar popup) and click an object in the page to rip
  just that object. The extension follows which draw call last changed the pixel under the cursor, so it also works
  through post-processing.
- **Ready for import**: the export is moved to the origin, centered and standing on the floor (option "Move to the
  origin"), and meshes drawn without normals get smooth normals that keep hard edges hard (option "Smooth normals
  when missing").
- Material colors are read from the shader (`diffuse`, `u_color`, `_Color`, `baseColorFactor`…), so untextured
  meshes keep their color in GLB and in the MTL file; face culling and blending decide `doubleSided` and transparency.
- A second keyboard shortcut "Pick one object in the current tab and rip it" in the browser's shortcut settings.

### Fixed

- Scenes where every object casts a shadow were ripped from the shadow map pass: meshes lost their positions and
  colors, all of them got the same texture, and picking found nothing. Of the passes that draw the same geometry,
  the one that ends up on the screen is kept now (followed through post-processing and framebuffer blits).
- Lit three.js materials came out white: the color of a light (`directionalLights[0].color`) was taken for the
  material color.
- A second rip on the same page dropped textured quads (floors, pictures, billboards) as post-processing passes,
  because textures read by the first rip were taken for render targets.
- The preview and pick UI are isolated in a closed shadow root and built without `innerHTML` or inline styles, so
  pages can't break them, also on sites with Trusted Types or a strict CSP.

## 1.0.2

Improvements from a rip of a model viewer (studio.tripo3d.ai).

### Fixed

- **Viewer chrome ended up in the export**: the axis gizmo in the corner (labels, axes, sphere) and the full-screen
  post-processing pass, which came with a screenshot of the whole frame as its texture. Meshes drawn into a small
  viewport and full-screen passes that sample a texture the page rendered itself are now skipped (new option
  "Skip viewer overlays", on by default).
- **Models drawn without an index buffer came out as loose triangles** (every triangle with its own three vertices),
  so they looked faceted and were hard to edit. Identical vertices are now merged (new option "Merge duplicate
  vertices", on by default): the Tripo model went from 30 099 vertices to 5 102.
- **Meshes fell apart along UV seams in Blender.** OBJ files used one index for position, UV and normal, so every
  seam duplicated the positions and Blender imported separate pieces. Each distinct position, UV and normal is now
  written once with its own index, and meshes stay connected.
- **When the camera couldn't be found, meshes were exported in camera space**, so their position and orientation
  depended on where the user was looking. They now keep their own coordinates, which for a model viewer is exactly
  how the model was made.
- The camera used to place `modelViewMatrix`-only meshes is now taken from the scene itself and no longer from
  overlays such as an axis gizmo, which use a camera of their own.
- `rip-info.json` lists the viewport, the matrix and the final transform of every mesh.

## 1.0.1

### Fixed

- **Chrome could run out of memory and crash when exporting large models** (for example high-poly models with 4K
  textures). The export used to build each OBJ file as one huge string and kept every file uncompressed in the page
  until the ZIP was assembled: an estimated 2.5 GB for a 1M vertex model with four 4K textures. OBJ text and PNG
  data are now produced in small pieces, compressed straight into the ZIP and moved out of the page's memory, and
  textures are read from the GPU in 4 MB bands: the same export now peaks at about 0.25 GB extra.
- Mesh data and cached GPU buffers are released as soon as they have been written.

## 1.0.0

A rewrite of the capture engine, the extension plumbing and the UI. Settings from 0.6 are kept.

### Fixed

- **Pages could break or get corrupted memory.** Hook errors were thrown into the page's own draw calls, the
  extension's helper functions and classes were declared in the page's global scope (name clashes stopped page
  scripts from loading), and `bufferSubData` wrote straight into the page's WebAssembly heap on Unity/Emscripten
  sites. Hooks are now isolated, never throw, and keep private copies of the data.
- **The hook was sometimes installed too late.** The engine was injected through an asynchronous `<script>` tag, so
  pages could create their WebGL context first. It now runs as a `MAIN` world content script at `document_start`.
- **Settings didn't load reliably** (they raced the page through a hidden `<div>`), and the defaults differed between
  the options page and the engine (debug logging was on by default, "Use Model View Matrix" was ignored). Settings
  now come from one place and apply immediately, without reloading the page.
- **Unity/Emscripten geometry was garbage**: index and vertex data uploaded as byte views of the heap were read with
  the wrong element type, WebGL 2 uploads with `srcOffset`/`length` copied the entire heap, and detached heaps after
  memory growth were not handled.
- Vertex attributes: normalized values (`UNSIGNED_SHORT` UVs, `BYTE` normals) were not normalized; interleaved data
  read one element past the end (NaN vertices) or threw on misaligned offsets; 2- and 4-component positions produced
  broken models; half floats and packed `2_10_10_10` normals were not supported; per-instance attributes were exported
  as vertex data.
- Draw state is read from the GL itself, so vertex array objects (WebGL 2, `OES_vertex_array_object`) no longer
  confuse the ripper about which attributes and index buffers are active.
- `drawRangeElements`, `drawArraysInstanced`, `ANGLE_instanced_arrays`, `WEBGL_multi_draw` and `TRIANGLE_FAN` are
  captured; triangle strips honour WebGL 2 primitive restart and degenerate triangles are dropped.
- Textures: the real size is now tracked for every upload path (`texImage2D` with explicit sizes, `texStorage2D`,
  compressed and copied textures), so the "default texture size" fallback is rarely needed; mipmap uploads no longer
  overwrite the size; the texture bound to the right unit is used. Compressed (DXT/ETC/ASTC…), float, half float,
  luminance and sRGB textures are exported through a draw-based copy instead of being skipped.
- PNGs are encoded byte-exact (the old canvas path premultiplied alpha and destroyed color in transparent texels).
- Texture names no longer need `crypto.randomUUID`, which failed on plain `http://` sites.
- The page's framebuffer, pixel-store and other GL state is saved and restored around texture reads (the old code
  left the default framebuffer bound, breaking rendering in apps that render to textures).
- Downloads: texture files had no `.png` extension, OBJ files referenced missing MTL files, blob URLs leaked, ZIP
  names contained `:`, files from consecutive rips overwrote each other, and Trusted Types pages blocked the download
  link.
- A capture now records exactly one frame, starting and ending on animation frame boundaries, instead of guessing from
  `clear()` calls ("Minimum Clears" is gone).
- The hotkey also works when the page swallows key events and when the WebGL canvas lives in an iframe.
- `deleteBuffer` freed the wrong map, buffers and textures were kept alive forever, and noisy logging (on by default)
  ran on every `getContext`/`getExtension` call of every website.
- Manifest: invalid `http://*/` host pattern, unused `tabs`/`contextMenus` permissions, deprecated `browser_style`,
  web-accessible resources that let any site detect the extension.

### Added

- Toolbar popup with status, a "Rip next frame" button and the result of the last capture; the toolbar badge shows
  when a page has WebGL content, while a capture is running and how many meshes were saved.
- Configurable hotkey (default Insert) and a browser keyboard shortcut ("Rip the next frame") that can be assigned in
  the browser's extension shortcut settings.
- Model matrices from uniform blocks (Babylon.js and other WebGL 2 engines), Unity's `hlslcc_mtx4x4` arrays and
  `modelViewMatrix`-only shaders (three.js) are applied, so meshes keep their place in the scene; normals are
  transformed too.
- Only the vertices a draw call uses are exported (previously every mesh contained the whole shared vertex buffer).
- Duplicate draws (depth pre-passes, shadow maps, reflections) are skipped.
- Optional combined `scene.obj`, shared `materials.mtl` with normal/roughness/metalness/emissive/specular/opacity maps,
  vertex colors, and a `rip-info.json` with details about every mesh.
- Much better name detection for attributes, samplers and matrices (three.js, Babylon.js, PlayCanvas, Unity, Godot,
  Pixi and others), plus "Advanced" options to add your own names.
- ZIP output is the default and no longer needs JSZip (removed, about 100 KB less in every page).
- Release packages per browser with clean manifests (`node scripts/build.mjs`), and tests that run the engine and the
  packaged extension in real Chrome and Firefox (`tests/run-chrome.mjs`, `tests/run-firefox.mjs`).

### Performance

- WebGL 2 buffers are read back from the GPU only during a capture instead of being copied on every upload.
- Uniform, divisor and uniform-block values are recorded from the page's own calls while a frame is captured instead
  of being queried with slow synchronous GL calls: recording a 3000 draw call frame went from about 3 s to about 0.1 s.
- Idle overhead on WebGL-heavy pages is on par with 0.6 even though WebGL 1 uploads are now copied correctly; uniform
  setters are only hooked while a frame is being captured.

### Removed

- "Shader Calc (WIP)": it never worked, forced every WebGL 1 page into a WebGL 2 context (breaking WebGL 1
  extensions) and suppressed all draw calls when enabled.
- "Minimum Clears", superseded by frame-accurate capture.
