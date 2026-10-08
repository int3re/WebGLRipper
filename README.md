# WebGL Ripper — extract 3D models from websites

**English** · [Русский](README.ru.md) · [Website](https://int3re.github.io/WebGLRipper/) · [Download](https://github.com/int3re/WebGLRipper/releases/latest)

[![Release](https://img.shields.io/github/v/release/int3re/WebGLRipper?label=release)](https://github.com/int3re/WebGLRipper/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Chrome 121+](https://img.shields.io/badge/Chrome%20%2F%20Edge-121%2B-4285F4)
![Firefox 128+](https://img.shields.io/badge/Firefox-128%2B-FF7139)

A browser extension that **rips 3D models and textures from WebGL pages** and saves them as **GLB (glTF 2.0)** or
**OBJ + MTL + PNG**, ready for Blender, Unity, Unreal, Godot or any other 3D tool. It records one rendered frame,
shows what it found in a 3D preview right in the page, and downloads the meshes you choose — with their textures,
material colors, normals and positions in the scene.

Works with three.js, Babylon.js, PlayCanvas, Unity WebGL, Godot, Emscripten apps and plain WebGL 1 / WebGL 2 code, in
Chrome, Edge, Brave, Opera and Firefox.

![The preview: the captured scene in 3D, a list of meshes to include or exclude, and the format](docs/images/preview.png)

## Features

- **GLB or OBJ.** One `.glb` with embedded textures and PBR materials (base color, normal, emissive, occlusion,
  metal/roughness, colors, transparency), or a ZIP with OBJ, MTL and PNG files — or both.
- **Preview before download.** Turn the scene around, click meshes to include or exclude them, choose the format.
- **Rip one object by clicking it.** Press <kbd>Shift</kbd>+<kbd>Insert</kbd> and click the object: only that object
  is saved. Works through post-processing too.
- **Ready to import.** The model is centered and stands on the floor, meshes keep their places, missing normals are
  computed (hard edges stay hard), vertices drawn separately are welded back together.
- **Clean output.** Shadow-map and depth passes, move and axis gizmos, outlines, full-screen post-processing passes
  and duplicate draws are left out automatically; sky domes are offered unselected.
- **Exact textures.** Saved byte for byte at their real size, including compressed (DXT/S3TC), float, half-float and
  luminance textures, and color under transparent pixels.
- **Light on the page.** Nothing is hooked per draw call until you press the hotkey; exports are streamed in small
  pieces, so even 4K-textured models don't run the tab out of memory. Nothing is ever sent anywhere.

| Pick mode | The picked object in the preview |
| --- | --- |
| ![Pick mode: "Click the object you want to rip"](docs/images/pick-hint.png) | ![Only the picked mesh is selected](docs/images/pick-preview.png) |

## Faster and better than the original

This is a rewrite of [WebGL Ripper 0.6 by Rilshrink](https://github.com/Rilshrink/WebGLRipper). Both versions were
installed as extensions in the same Chrome and run on the same test pages
([full comparison and method](docs/comparison.md)):

| Test page | Original 0.6 | This version |
| --- | --- | --- |
| three.js scene with shadows and post-processing | 4 objects, all at the origin, no normals; a 256×256 texture saved as 4096×4096 and put on every mesh; page froze for 0.4–0.6 s | 4 objects in place with normals, colors and the right texture: GLB in **0.17 s**, longest frame 41 ms |
| 3000 draw calls per frame | no file after 3 minutes, page frozen, **+1.3 GB** of memory | **0.28 s** as GLB (+42 MB), 0.7 s as OBJ ZIP (+78 MB) |
| Model with 250 000 vertices and two 4K textures | 3.9 s, page frozen for **1.5 s**, +590 MB (+226 MB GPU), **60 MB** ZIP, model moved off its place | **1.6 s** as GLB, 2.7 s as a **5.6 MB** OBJ ZIP; longest frame under 0.2 s, +169–245 MB |
| Unity / Emscripten-style memory | garbage (every vertex at 3.4·10³⁸) | exact |
| WebGL context created while the page loads | not captured at all | captured |
| Frame time with 3000 draw calls (no capture running) | +0.4–0.5 ms, about twice as slow | no difference beyond measurement noise (±0.1 ms) |

## Installation

1. Download the package for your browser from the [latest release](https://github.com/int3re/WebGLRipper/releases/latest):
   `webglripper-<version>-chrome.zip` or `webglripper-<version>-firefox.zip`.
2. **Chrome / Edge / Brave / Opera:** unzip it, open `chrome://extensions/` (`edge://extensions/` in Edge), enable
   **Developer mode**, click **Load unpacked** and select the unzipped folder.
3. **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and select the
   `-firefox.zip`. Temporary add-ons are removed when Firefox restarts.

Reload pages that were already open. To update, replace the folder with the new version and click ⟳ on the
extension's card.

> WebGL Ripper is not published on the Chrome Web Store or any other store. Copies found there are not from this
> project and may contain malicious code.

## How to rip

1. Open a page with WebGL content and wait until the model is visible.
2. Press <kbd>Insert</kbd> (or click the toolbar button → **Rip next frame**).
3. The preview opens. Click meshes to include or exclude them, choose GLB or OBJ, press **Download** (or
   <kbd>Enter</kbd>; <kbd>Esc</kbd> cancels).

**Just one object?** Press <kbd>Shift</kbd>+<kbd>Insert</kbd> (or **Pick object** in the popup) and click it.

The toolbar badge shows **GL** when the page has WebGL content, **PICK** while waiting for your click, **REC** while a
frame is recorded, **SEL** while the preview is open, and then the number of saved meshes. If a scene only redraws when
something changes, move the camera a little after pressing the hotkey. No <kbd>Insert</kbd> key? Choose other hotkeys
in the options, or assign browser shortcuts in `chrome://extensions/shortcuts` (Firefox: *Add-ons → ⚙ → Manage
Extension Shortcuts*).

## What you get

**GLB** (default): `webglripper_<site>_<date>-<time>.glb` — one file with every mesh, its textures and material. In
Blender: *File → Import → glTF 2.0 (.glb/.gltf)*.

**OBJ:**

```
webglripper_<site>_<date>-<time>.zip
├── mesh_000.obj …        one OBJ per mesh (or a single scene.obj, see options)
├── materials.mtl         materials: colors and texture maps
├── textures/tex_000.png  textures, byte-exact
├── model.glb             with the format "GLB + OBJ"
└── rip-info.json         what was captured: attributes, textures and transforms of every mesh
```

In Blender: *File → Import → Wavefront (.obj)*, select all OBJ files (or `scene.obj`).

## Options

| Option | Default | |
| --- | --- | --- |
| Hotkey | Insert | Rips the current tab. |
| Pick hotkey | Shift + Insert | The next click on the page rips only the object under the cursor. |
| Preview before download | on | Shows the capture in the page so you can choose what to keep. |
| Skip duplicate draws | on | Ignores geometry drawn again by depth or shadow passes. |
| Skip viewer overlays | on | Ignores axis gizmos, helpers in a small viewport and post-processing passes. |
| Format | GLB | GLB, OBJ, or both. |
| Download OBJ as ZIP | on | One file per capture instead of one download per file. |
| OBJ layout | One OBJ per mesh | Or a single `scene.obj`, or both. |
| Place meshes in the scene | on | Applies the model matrix found in the shader. |
| Move to the origin | on | Centers the export and stands it on the floor. |
| Smooth normals when missing | on | Computes normals for meshes drawn without any; hard edges stay hard. |
| Export vertex colors | on | `v x y z r g b` in OBJ, `COLOR_0` in GLB. |
| Merge duplicate vertices | on | Reconnects triangles that the page drew as separate vertices. |
| Unflip textures | on | Keeps UVs and images consistent for OBJ viewers. |
| Fallback texture size | 4096 × 4096 | Only used when a texture's size could not be detected. |
| Advanced | | Extra attribute, sampler and matrix names for engines that aren't recognized. |
| Debug logging | off | Prints details to the page's developer console. |

![The options page](docs/images/options.png)

## How it works

In short: the engine runs inside the page before any page script, wraps a few WebGL functions and, when you press the
hotkey, records every draw call of the next frame — the geometry, the textures bound to it and the matrices in its
shader. The recorded draws are cleaned up (shadow passes, gizmos and duplicates removed, vertices welded, normals
computed), shown in the preview and written as GLB or OBJ in small streamed pieces. Pick mode reads the pixel under the
cursor after every draw call to find the one that drew the object you clicked.

The whole story — hooks, matrix and texture heuristics, readback of compressed and float textures, streaming export,
the preview, pick mode, performance and privacy — is in **[How WebGL Ripper works](docs/how-it-works.md)**.

## FAQ

**Which sites does it work on?** Any page that draws with WebGL in the browser: product viewers and configurators, 3D
galleries, games made with Unity, Godot or PlayCanvas, three.js and Babylon.js demos. It doesn't work on pages that
render on a server and stream video, or that draw from a Web Worker with `OffscreenCanvas`.

**Why are some models in a T-pose or without animation?** Characters animated on the GPU (skinning, morph targets) are
saved in their bind pose: the vertex shader moves the vertices, and the original data is what the page uploaded.

**The export is empty or meshes are in the wrong place.** Enable **Debug logging** and look at `rip-info.json` for the
attribute and uniform names the page uses, then add them under **Options → Advanced**. Please open an issue with the
site and the file.

**Does it send my data anywhere?** No. The extension makes no network requests; everything happens in your browser.

## Limitations

- GPU-skinned characters are saved in their bind pose; morph targets are not applied.
- WebGL inside a Web Worker (`OffscreenCanvas` transferred to a worker) can't be captured.
- Instanced draws export one copy of the instanced geometry.
- `WEBGL_multi_draw` batches don't expose per-object transforms; their meshes stay in local space.
- Exporting happens inside the page: very large models still need some free memory (about 250 MB for a 1M vertex
  model with four 4K textures on top of what the page uses).
- Pages inside sandboxed iframes without download permission can't save files; open the iframe's address in a tab.

## Responsible use

Models, textures and scenes on websites belong to their authors. Rip only what you are allowed to use — your own work,
assets under a permissive license, or content you have permission for — and respect the site's terms and licenses.

## Development

There is no build step: the repository folder is the extension (`node scripts/build.mjs` makes the release packages in
`dist/`).

- `webglripper.js` – capture engine, runs in the page (`MAIN` world) at `document_start`
- `viewer.js` – preview and pick UI, in the page, isolated in a closed shadow root
- `bridge.js` – content script between the engine and the extension (settings, hotkeys, progress)
- `background.js` – sends captures to every frame of a tab, toolbar badge, keyboard shortcuts
- `popup.*`, `options.*`, `ui.css`, `settings.js` – user interface and shared defaults

Tests run in real browsers through their automation protocols and need only Node.js 22+:

```
node tests/run-chrome.mjs
node tests/run-firefox.mjs
node tests/compare/compare.mjs --original=<folder of WebGL Ripper 0.6>
```

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Credits

Based on [WebGLRipper](https://github.com/Rilshrink/WebGLRipper) by Rilshrink. MIT License.

<sub>Keywords: WebGL ripper, 3D model ripper, extract 3D model from website, download 3D model from a web page, three.js
model export, Babylon.js export, Unity WebGL model extractor, GLB / glTF exporter, OBJ exporter, Blender import, Chrome
extension, Firefox add-on.</sub>
