# WebGL Ripper

A browser extension that rips 3D models and textures from WebGL pages. It records one rendered frame, shows you what
it found in a 3D preview, and saves the meshes you choose as GLB (or OBJ + MTL + PNG) with their textures and
materials, ready to import into Blender or any other 3D tool.

Works with Chrome, Edge, Brave, Opera (Chrome 121+) and Firefox 128+, with WebGL 1 and WebGL 2, and with engines such
as three.js, Babylon.js, PlayCanvas, Unity WebGL, Godot and plain WebGL code.

> You will **NOT** find this extension on the Chrome Web Store or any other extension platform! If you do find it
> there, it wasn't published by me and may contain malicious code.

## Installation

Download the package for your browser from the releases page (`webglripper-<version>-chrome.zip` or
`webglripper-<version>-firefox.zip`) and unzip it somewhere safe.

**Chrome / Edge / Brave / Opera**

1. Go to `chrome://extensions/` (`edge://extensions/` in Edge).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).

**Firefox**

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select the downloaded `-firefox.zip` (or `manifest.json` in the unzipped folder).

Temporary add-ons are removed when Firefox restarts. If Firefox asks, allow the extension to access all websites.

Pages that were already open before installing or updating need to be reloaded.

You can also use the source code directly (green **<> Code** button → **Download ZIP**): the repository folder loads in
both browsers. Chrome then lists a note that `background.scripts` requires manifest version 2; that entry is only there
for Firefox and the note can be ignored (the release packages don't have it).

## How to rip

1. Open a page with WebGL content and wait until the model is visible.
2. Press **Insert**, or click the WebGL Ripper toolbar button and choose **Rip next frame**.
3. The next frame is recorded and the preview opens in the page. Turn the model around, click meshes to include or
   exclude them, choose GLB or OBJ and press **Download** (or Enter; Esc cancels).

**Just one object?** Press **Shift+Insert** (or **Pick object** in the popup) and click the object in the page: only
that object is ripped.

The toolbar badge shows **GL** when the page has WebGL content, **PICK** while waiting for your click, **REC** while a
frame is being recorded, **SEL** while the preview is open, and then the number of meshes that were saved. If the
scene only redraws when something changes, move the camera a little after starting the rip.

No Insert key on your keyboard? Pick other hotkeys in the options, or assign browser shortcuts to "Rip the next
frame" and "Pick one object" in `chrome://extensions/shortcuts` (Firefox: *Add-ons → ⚙ → Manage Extension
Shortcuts*).

## What you get

**GLB** (default): `webglripper_<site>_<date>-<time>.glb`, a single file with every mesh, its textures and PBR
material. In Blender: *File → Import → glTF 2.0 (.glb/.gltf)*.

**OBJ**:

```
webglripper_<site>_<date>-<time>.zip
├── mesh_000.obj …        one OBJ per draw call (or a single scene.obj, see options)
├── materials.mtl         shared material library
├── textures/tex_000.png  textures, exported byte-exact
├── model.glb             with the format "GLB + OBJ"
└── rip-info.json         what was captured: attributes, textures and transforms of every mesh
```

In Blender: *File → Import → Wavefront (.obj)*, select all OBJ files (or `scene.obj`).

The export stands on the origin. Meshes keep their places relative to each other when "Place meshes in the scene"
is enabled.

## Options

Open them from the popup (**Options**) or from the browser's extension page.

| Option | Default | |
| --- | --- | --- |
| Hotkey | Insert | Key combination that rips the current tab. |
| Pick hotkey | Shift + Insert | The next click on the page rips only the object under the cursor. |
| Preview before download | on | Shows the capture in the page so you can choose what to keep. |
| Skip duplicate draws | on | Ignores geometry drawn again by depth or shadow passes. |
| Skip viewer overlays | on | Ignores axis gizmos and other helpers in a small viewport, and post-processing passes. |
| Format | GLB | GLB, OBJ, or both. |
| Download OBJ as ZIP | on | One file per capture instead of one download per file. |
| OBJ layout | One OBJ per mesh | Or a single `scene.obj`, or both. |
| Place meshes in the scene | on | Applies the model matrix found in the shader. If the page only exposes a camera-relative matrix and the camera can't be found, the mesh keeps its own coordinates. |
| Move to the origin | on | Centers the export and stands it on the floor. |
| Smooth normals when missing | on | Computes normals for meshes drawn without any; hard edges stay hard. |
| Export vertex colors | on | Written as `v x y z r g b` in OBJ and as `COLOR_0` in GLB. |
| Merge duplicate vertices | on | Reconnects triangles that the page drew as separate vertices. |
| Unflip textures | on | Keeps UVs and images consistent for OBJ viewers. |
| Fallback texture size | 4096 × 4096 | Only used when a texture's size could not be detected. |
| Advanced | | Extra attribute, sampler and matrix names for engines that aren't recognized. |
| Debug logging | off | Prints details to the page's developer console. |

## Limitations

- Animated characters that are skinned on the GPU are exported in their bind pose; morph targets are not applied.
- WebGL running inside a Web Worker (`OffscreenCanvas` transferred to a worker) can't be captured.
- Instanced draws export one copy of the instanced geometry.
- Multi-draw (`WEBGL_multi_draw`) batches don't expose per-object transforms, so their meshes stay in local space.
- Exporting is done inside the page, so very large models still need some free memory (roughly 250 MB for a
  1M vertex model with four 4K textures, on top of what the page itself uses). If the system is short on memory,
  close other heavy applications first.
- Pages inside sandboxed iframes without download permission can't save files. Open the iframe's address directly
  in a tab instead.
- Texture names, attribute names and matrix names are recognized heuristically. If a page exports nothing, or meshes
  land in the wrong place, check `rip-info.json` or the debug log for the names the page uses and add them under
  **Options → Advanced**.

## Issues?

If you encounter any issues after installing this extension:

1. Disable the extension and see if the issue persists.
2. Check for conflicting extensions or browser settings.
3. If the issue only happens with the extension enabled, please report it here.

Please include your browser version, operating system, the website you were testing, any error messages, and if
possible the `rip-info.json` from the capture (with **Debug logging** enabled, the console output is helpful too).

Thank you in advance!

## Development

There is no build step: the repository folder is the extension.

- `webglripper.js` – the capture engine, runs in the page (`MAIN` world) at `document_start`
- `viewer.js` – the preview and pick UI, also in the page, isolated in a closed shadow root
- `bridge.js` – content script connecting the engine with the extension (settings, hotkey, progress)
- `background.js` – broadcasts captures to every frame of a tab, toolbar badge, keyboard shortcut
- `popup.*`, `options.*`, `ui.css`, `settings.js` – user interface and shared defaults

Tests run in real browsers through their automation protocols and need only Node.js 22+:

```
node tests/run-chrome.mjs
node tests/run-firefox.mjs
```

The extension tests load the release packages, which `node scripts/build.mjs` creates in `dist/` (an unpacked folder
and a ZIP per browser). `tests/engine.html` can also be opened directly in a browser, and `tests/bench.html`
(`?engine=0` for a baseline) measures the per-frame overhead and capture time on a 3000 draw call scene.
`tests/heavy.html?grid=1000&textures=4` is a 1M vertex scene with 4K textures for checking memory use of big exports.
`tests/demo.html` (served over HTTP) is a three.js scene with shadows and post-processing whose buttons open the
preview and pick mode without the extension installed.

See [CHANGELOG.md](CHANGELOG.md) for what changed.

## Credits

Based on [WebGLRipper](https://github.com/Rilshrink/WebGLRipper) by Rilshrink (MIT License).
