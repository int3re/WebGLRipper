/*
 * WebGL Ripper - preview and pick UI.
 *
 * Runs in the page's MAIN world right after webglripper.js and registers itself with the engine. The UI lives in a
 * closed shadow root so the page's styles can't reach it, is built with DOM calls only (no innerHTML) and styled
 * with a constructed stylesheet, so it also works on pages with Trusted Types or a strict CSP.
 */
(function () {
'use strict';

const registry = window[Symbol.for('webglripper.engine')];
if (!registry || typeof registry.registerViewer !== 'function')
	return;

const apply = Reflect.apply;
const native = {
	createElement: Document.prototype.createElement,
	attachShadow: Element.prototype.attachShadow,
	appendChild: Node.prototype.appendChild,
	addEventListener: EventTarget.prototype.addEventListener,
	removeEventListener: EventTarget.prototype.removeEventListener,
	requestAnimationFrame: window.requestAnimationFrame.bind(window),
	setTimeout: window.setTimeout.bind(window),
	clearTimeout: window.clearTimeout.bind(window),
	createImageBitmap: typeof window.createImageBitmap === 'function' ? window.createImageBitmap.bind(window) : null,
	getContext: HTMLCanvasElement.prototype.getContext,
	CSSStyleSheet: window.CSSStyleSheet,
	ResizeObserver: window.ResizeObserver
};

const CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; color-scheme: dark;
	font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e8eaed; }
:host(.hint-host) { inset: auto; top: 16px; left: 50%; transform: translateX(-50%); pointer-events: none; }
* { box-sizing: border-box; }
.hint { background: #1d1f24; border: 1px solid #3c4048; border-radius: 999px; padding: 8px 16px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, .45); white-space: nowrap; }
.hint b { color: #8ab4f8; font-weight: 600; }
.backdrop { position: absolute; inset: 0; display: flex; background: rgba(12, 13, 16, .96); }
.stage { position: relative; flex: 1; min-width: 0; }
.stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; outline: none; }
.stage canvas.dragging { cursor: grabbing; }
.stage .brand { position: absolute; left: 16px; top: 14px; font-weight: 600; font-size: 14px; pointer-events: none; }
.stage .help { position: absolute; left: 16px; bottom: 14px; color: #9aa0a6; font-size: 12px; pointer-events: none; }
.stage .fallback { position: absolute; inset: 0; display: grid; place-items: center; color: #9aa0a6; }
aside { width: 340px; display: flex; flex-direction: column; background: #1d1f24; border-left: 1px solid #30333a; }
header { padding: 16px 16px 10px; }
h1 { margin: 0; font-size: 15px; font-weight: 600; }
.meta { color: #9aa0a6; font-size: 12px; margin-top: 2px; }
.tools { display: flex; gap: 6px; padding: 0 16px 10px; }
.list { flex: 1; overflow: auto; padding: 0 8px; }
.item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; cursor: pointer; user-select: none; }
.item:hover, .item.hover { background: #2a2d33; }
.item.off .text { color: #80868b; }
.item.off canvas { opacity: .45; }
.item canvas { width: 40px; height: 40px; border-radius: 6px; flex: none; background: #2a2d33; }
.item .text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .info { color: #9aa0a6; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .badge { color: #13161a; background: #fdd663; border-radius: 4px; padding: 0 5px; font-size: 11px; margin-left: 6px; }
.item .badge.muted { color: #c4c9d2; background: #3c4048; }
input[type="checkbox"] { width: 16px; height: 16px; accent-color: #8ab4f8; flex: none; margin: 0; }
.section { padding: 12px 16px 0; color: #9aa0a6; font-size: 12px; }
.format { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 6px 16px 0; }
.compact { display: flex; align-items: center; gap: 8px; padding: 10px 16px 0; color: #c4c9d2; font-size: 12px; cursor: pointer; }
.compact.disabled { opacity: .45; cursor: default; }
@media (max-width: 720px) {
	.backdrop { flex-direction: column; }
	aside { width: auto; max-height: 60%; border-left: none; border-top: 1px solid #30333a; }
	.stage .help { display: none; }
}
.format button { min-width: 0; padding: 6px 4px; }
.format button.on { background: #8ab4f8; border-color: #8ab4f8; color: #13161a; font-weight: 600; }
.actions { display: flex; gap: 8px; padding: 14px 16px 16px; }
button { font: inherit; color: #e8eaed; background: #2a2d33; border: 1px solid #3c4048; border-radius: 8px;
	padding: 6px 12px; cursor: pointer; }
button:hover { border-color: #5f6672; }
button:disabled { opacity: .5; cursor: default; }
button.primary { flex: 1; background: #8ab4f8; border-color: #8ab4f8; color: #13161a; font-weight: 600; }
`;

/* ---- small DOM helpers ---- */

function element(tag, className, text) {
	const node = apply(native.createElement, document, [tag]);
	if (className)
		node.className = className;
	if (text !== undefined)
		node.textContent = text;
	return node;
}

function append(parent, ...children) {
	for (const child of children)
		apply(native.appendChild, parent, [child]);
	return parent;
}

function createHost(extraClass) {
	const host = element('webglripper-ui');
	if (extraClass)
		host.className = extraClass;
	const root = apply(native.attachShadow, host, [{ mode: 'closed' }]);
	try {
		const sheet = new native.CSSStyleSheet();
		sheet.replaceSync(CSS);
		root.adoptedStyleSheets = [sheet];
	} catch (err) {
		append(root, element('style', '', CSS)); // older browsers; may be blocked by a strict CSP
	}
	append(document.documentElement, host);
	return { host, root };
}

const formatCount = (n) => n.toLocaleString('en-US').replace(/,/g, ' ');
// the interface language, from the engine (English when bridge.js sent no translations)
const t = (text, values) => registry.t(text, values);
const plural = (n, forms) => registry.plural(n, forms);
const formatLength = (n) => (n >= 100 ? String(Math.round(n)) : String(Number(n.toPrecision(3))));

/* The second line of a list row: triangles, base color texture, size. */
function describeMesh(mesh, entry) {
	const parts = [t('{count} tris', { count: formatCount(mesh.triangleCount) })];
	if (mesh.textureWidth)
		parts.push(t('{size} texture', { size: `${mesh.textureWidth}×${mesh.textureHeight}` }));
	if (entry && entry.lo[0] <= entry.hi[0]) {
		const size = [0, 1, 2].map(k => entry.hi[k] - entry.lo[k]);
		const largest = Math.max(...size);
		parts.push(size.map(n => formatLength(n < largest * 1e-4 ? 0 : n)).join(' × ')); // a flat plane is 0 thick
	}
	return parts.join(' · ');
}

/* ---- pick mode hint ---- */

let hintHost = null;
function hint(text) {
	if (hintHost) {
		hintHost.remove();
		hintHost = null;
	}
	if (!text)
		return;
	const { host, root } = createHost('hint-host');
	const pill = element('div', 'hint');
	append(pill, element('b', '', 'WebGL Ripper  '), document.createTextNode(text));
	append(root, pill);
	hintHost = host;
}

/* ---- matrices (column-major) ---- */

function perspective(fovy, aspect, near, far) {
	const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
	return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(eye, target) {
	let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
	let length = Math.hypot(zx, zy, zz) || 1;
	zx /= length; zy /= length; zz /= length;
	let xx = zz, xy = 0, xz = -zx; // up = (0, 1, 0) x z
	length = Math.hypot(xx, xy, xz) || 1;
	xx /= length; xy /= length; xz /= length;
	const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
	return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
		-(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1];
}

function multiply(a, b) {
	const out = new Float32Array(16);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++)
			out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
	return out;
}

/* ---- the 3D view ---- */

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
layout(location = 3) in vec3 vertexColor;
uniform mat4 viewProjection;
uniform float flipV;
out vec3 vNormal;
out vec2 vUv;
out vec3 vPosition;
out vec3 vColor;
void main() {
	vNormal = normal;
	vColor = vertexColor;
	vUv = vec2(uv.x, flipV > 0.5 ? 1.0 - uv.y : uv.y);
	vPosition = position;
	gl_Position = viewProjection * vec4(position, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
in vec3 vPosition;
in vec3 vColor;
uniform sampler2D map;
uniform sampler2D normalMap;
uniform sampler2D roughnessMap;
uniform sampler2D metalnessMap;
uniform float useMap;
uniform float useNormalMap;
uniform float useRoughnessMap;
uniform float useMetalnessMap;
uniform float useColors;
uniform float hasNormals;
uniform float flipV;
uniform float roughness;
uniform float metalness;
uniform vec4 color;
uniform vec3 eye;
uniform vec3 tint;
uniform float tintAmount;
uniform float alpha;
uniform vec4 idColor;
uniform float idPass;
out vec4 outColor;

// A soft studio around the model: light from above, a dark floor and two soft boxes, so that metal has something to
// reflect. Rough surfaces see a blurred version of it.
vec3 studio(vec3 d, float rough) {
	vec3 sky = mix(vec3(0.42, 0.43, 0.46), vec3(1.2, 1.21, 1.25), smoothstep(0.0, 0.9, d.y));
	vec3 env = mix(vec3(0.06, 0.06, 0.065), sky, smoothstep(-0.3, 0.05, d.y));
	float sharp = mix(80.0, 2.0, rough);
	float boxes = 3.2 * pow(max(dot(d, normalize(vec3(0.55, 0.45, 0.7))), 0.0), sharp)
		+ 1.8 * pow(max(dot(d, normalize(vec3(-0.75, 0.25, -0.45))), 0.0), sharp);
	return env + vec3(boxes * mix(1.0, 0.25, rough));
}

void main() {
	if (idPass > 0.5) {
		outColor = idColor;
		return;
	}
	vec3 v = normalize(eye - vPosition);
	vec3 n = hasNormals > 0.5 ? normalize(vNormal) : normalize(cross(dFdx(vPosition), dFdy(vPosition)));
	if (dot(n, v) < 0.0)
		n = -n;
	if (useNormalMap > 0.5) {
		// tangent frame from screen-space derivatives (no tangents needed)
		vec3 mapN = texture(normalMap, vUv).xyz * 2.0 - 1.0;
		mapN.y *= flipV > 0.5 ? 1.0 : -1.0;
		vec3 q0 = dFdx(vPosition), q1 = dFdy(vPosition);
		vec2 st0 = dFdx(vUv), st1 = dFdy(vUv);
		vec3 q1perp = cross(q1, n), q0perp = cross(n, q0);
		vec3 t = q1perp * st0.x + q0perp * st1.x;
		vec3 b = q1perp * st0.y + q0perp * st1.y;
		float det = max(dot(t, t), dot(b, b));
		if (det > 0.0)
			n = normalize(t * (mapN.x * inversesqrt(det)) + b * (mapN.y * inversesqrt(det)) + n * mapN.z);
	}
	// lighting in linear light: textures are sRGB, material and vertex colors linear (as in glTF)
	vec4 texel = useMap > 0.5 ? texture(map, vUv) : vec4(1.0);
	vec3 albedo = color.rgb * pow(texel.rgb, vec3(2.2));
	if (useColors > 0.5)
		albedo *= clamp(vColor, 0.0, 1.0);
	float rough = clamp(roughness * (useRoughnessMap > 0.5 ? texture(roughnessMap, vUv).g : 1.0), 0.05, 1.0);
	float metal = clamp(metalness * (useMetalnessMap > 0.5 ? texture(metalnessMap, vUv).b : 1.0), 0.0, 1.0);
	float nv = max(dot(n, v), 0.0);
	vec3 f0 = mix(vec3(0.04), albedo, metal);
	vec3 fresnel = f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
	vec3 specular = studio(reflect(-v, n), rough) * fresnel;
	vec3 key = normalize(v + vec3(0.25, 0.6, 0.2)); // follows the camera
	vec3 diffuse = albedo * (1.0 - metal) * (studio(n, 1.0) * 0.3 + max(dot(n, key), 0.0));
	vec3 lit = diffuse + specular;
	lit /= 1.0 + 0.15 * lit; // soft shoulder for bright highlights
	outColor = vec4(mix(pow(lit, vec3(1.0 / 2.2)), tint, tintAmount), alpha);
}`;

/* The textures of a preview mesh: data key, sampler, "use" flag. The unit is the index. */
let openView = null; // the preview on screen, for update()
const MAPS = [['texture', 'map', 'useMap'], ['normalTexture', 'normalMap', 'useNormalMap'],
	['roughnessTexture', 'roughnessMap', 'useRoughnessMap'], ['metalnessTexture', 'metalnessMap', 'useMetalnessMap']];

class View {
	constructor(canvas, data) {
		this.canvas = canvas;
		this.data = data;
		this.meshes = [];
		this.hover = -1;
		this.yaw = 0.55;
		this.pitch = 0.3;
		this.distance = 1;
		this.target = [0, 0, 0];
		this.frameScheduled = false;
		this.textures = new Map();   // PNG Blob -> promise of { texture, thumbnail }, shared by the meshes using it
		this.glTextures = [];
		this.thumbnails = [];
		registry.ownCanvas(canvas);
		const gl = this.gl = apply(native.getContext, canvas, ['webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false }]);
		if (!gl)
			return;
		const compile = (type, source) => {
			const shader = gl.createShader(type);
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			return shader;
		};
		const program = this.program = gl.createProgram();
		gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
		gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			this.gl = null;
			return;
		}
		this.uniforms = {};
		for (const name of ['viewProjection', 'flipV', 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'useMap', 'useNormalMap',
			'useRoughnessMap', 'useMetalnessMap', 'roughness', 'metalness', 'useColors', 'hasNormals', 'color', 'eye', 'tint', 'tintAmount', 'alpha', 'idColor', 'idPass'])
			this.uniforms[name] = gl.getUniformLocation(program, name);
		gl.useProgram(program);
		MAPS.forEach(([, uniform], unit) => gl.uniform1i(this.uniforms[uniform], unit));

		for (const [index, mesh] of data.meshes.entries())
			this.meshes.push(this.upload(mesh, index));
		this.grid = this.buildGrid();
		this.frame(false);
	}

	upload(mesh, index) {
		const gl = this.gl;
		const vao = gl.createVertexArray();
		gl.bindVertexArray(vao);
		const buffers = [];
		const attribute = (location, data, size) => {
			if (!data)
				return;
			const buffer = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
			gl.enableVertexAttribArray(location);
			gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
			buffers.push(buffer);
		};
		attribute(0, mesh.positions, 3);
		attribute(1, mesh.normals, 3);
		attribute(2, mesh.uvs, 2);
		attribute(3, mesh.colors, 3);
		const indices = gl.createBuffer();
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.triangles, gl.STATIC_DRAW);
		buffers.push(indices);
		gl.bindVertexArray(null);

		const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		const p = mesh.positions;
		for (let i = 0; i < p.length; i += 3) {
			for (let k = 0; k < 3; k++) {
				if (p[i + k] < lo[k]) lo[k] = p[i + k];
				if (p[i + k] > hi[k]) hi[k] = p[i + k];
			}
		}
		const entry = { index, vao, buffers, count: mesh.triangles.length, texture: null, bitmap: null, lo, hi, source: mesh, loaded: new Map() };
		entry.loading = this.loadMaps(entry);
		return entry;
	}

	/* The base color texture first (it also gives the list its picture), then the maps that make metal look like metal.
	 * Maps can arrive later (see update), so this runs again and only loads what is new. */
	async loadMaps(entry) {
		if (!native.createImageBitmap)
			return;
		for (const [key] of MAPS) {
			const blob = entry.source[key];
			if (!blob || entry.loaded.get(key) === blob)
				continue;
			entry.loaded.set(key, blob);
			// Meshes often share a texture (atlases): each one is decoded and uploaded once
			let shared = this.textures.get(blob);
			if (!shared) {
				const base = key === 'texture';
				this.textures.set(blob, shared = this.decodeTexture(blob, base ? entry.source.textureWidth : 0, base ? entry.source.textureHeight : 0, base));
			}
			const decoded = await shared;
			if (!decoded || this.disposed)
				return;
			entry[key] = decoded.texture;
			if (key === 'texture')
				entry.bitmap = decoded.thumbnail;
			if (this.onTexture)
				this.onTexture(entry);
			this.request();
		}
	}

	/* Decodes a PNG straight at preview size (at most 2048 pixels, less for thumbnails); the base color also keeps a
	 * small copy for the list. */
	async decodeTexture(blob, width, height, withThumbnail) {
		const limit = this.data.textureLimit || 2048;
		const scale = width > 0 && height > 0 ? Math.min(1, limit / Math.max(width, height)) : 1;
		let bitmap = null;
		try {
			try {
				bitmap = scale < 1
					? await native.createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(width * scale)), resizeHeight: Math.max(1, Math.round(height * scale)), resizeQuality: 'medium' })
					: this.data.textureLimit && !(width > 0) // size unknown: the width alone keeps the aspect ratio
						? await native.createImageBitmap(blob, { resizeWidth: limit, resizeQuality: 'medium' })
						: await native.createImageBitmap(blob);
			} catch (err) {
				bitmap = await native.createImageBitmap(blob); // resize options not supported
			}
			if (this.disposed)
				return null;
			const gl = this.gl;
			const texture = gl.createTexture();
			this.glTextures.push(texture);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
			gl.generateMipmap(gl.TEXTURE_2D);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
			let thumbnail = null;
			try {
				if (withThumbnail)
					thumbnail = await native.createImageBitmap(bitmap, { resizeWidth: 68, resizeHeight: 68, resizeQuality: 'medium' });
				if (thumbnail && this.disposed)
					thumbnail.close();
				else if (thumbnail)
					this.thumbnails.push(thumbnail);
			} catch (err) {
				// the list shows the material color instead
			}
			return { texture, thumbnail };
		} catch (err) {
			return null;
		} finally {
			if (bitmap)
				bitmap.close();
		}
	}

	bounds(onlySelected) {
		const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		for (const mesh of this.meshes) {
			if (onlySelected && !mesh.source.selected)
				continue;
			for (let k = 0; k < 3; k++) {
				lo[k] = Math.min(lo[k], mesh.lo[k]);
				hi[k] = Math.max(hi[k], mesh.hi[k]);
			}
		}
		return lo[0] <= hi[0] ? { lo, hi } : null;
	}

	buildGrid() {
		const gl = this.gl;
		// around what will be downloaded: a sky dome would make the grid huge
		const box = this.bounds(true) || this.bounds(false) || { lo: [-1, 0, -1], hi: [1, 1, 1] };
		const size = Math.max(box.hi[0] - box.lo[0], box.hi[2] - box.lo[2], 1e-3) * 1.6;
		const step = Math.pow(10, Math.floor(Math.log10(size / 4)));
		const lines = [];
		// just below the model, so a floor in the model hides the grid instead of z-fighting with it
		const cx = (box.lo[0] + box.hi[0]) / 2, cz = (box.lo[2] + box.hi[2]) / 2, y = box.lo[1] - size * 1e-3;
		const half = Math.ceil(size / 2 / step) * step;
		for (let t = -half; t <= half + 1e-9; t += step) {
			lines.push(cx + t, y, cz - half, cx + t, y, cz + half, cx - half, y, cz + t, cx + half, y, cz + t);
		}
		const vao = gl.createVertexArray();
		gl.bindVertexArray(vao);
		const buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);
		return { vao, buffer, count: lines.length / 3 };
	}

	/* Points the camera at the selected meshes (or everything when nothing is selected). */
	frame(render = true) {
		const box = this.bounds(true) || this.bounds(false);
		if (!box)
			return;
		this.target = [0, 1, 2].map(k => (box.lo[k] + box.hi[k]) / 2);
		const radius = Math.max(Math.hypot(box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]) / 2, 1e-4);
		this.distance = radius / Math.sin(Math.PI / 8) * 1.05;
		if (render)
			this.request();
	}

	camera() {
		const width = Math.max(1, this.canvas.width), height = Math.max(1, this.canvas.height);
		const cp = Math.cos(this.pitch);
		const eye = [
			this.target[0] + this.distance * cp * Math.sin(this.yaw),
			this.target[1] + this.distance * Math.sin(this.pitch),
			this.target[2] + this.distance * cp * Math.cos(this.yaw)
		];
		const view = lookAt(eye, this.target);
		const projection = perspective(Math.PI / 4, width / height, this.distance / 200, this.distance * 200);
		return { eye, view, viewProjection: multiply(projection, view) };
	}

	request() {
		if (this.frameScheduled || this.disposed || !this.gl)
			return;
		this.frameScheduled = true;
		native.requestAnimationFrame(() => {
			this.frameScheduled = false;
			if (!this.disposed)
				this.render();
		});
	}

	resize() {
		const ratio = Math.min(window.devicePixelRatio || 1, 2);
		const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
		const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
	}

	drawMesh(mesh, alpha, tintAmount) {
		const gl = this.gl, u = this.uniforms, source = mesh.source;
		// Material colors are linear (as in glTF) and textures are sRGB: shown the way a glTF importer shows them
		const color = source.color || [0.6, 0.6, 0.62, 1];
		gl.uniform4f(u.color, color[0], color[1], color[2], 1);
		MAPS.forEach(([key, , flag], unit) => {
			const usable = !!mesh[key] && (key === 'texture' || !!source.uvs);
			gl.uniform1f(u[flag], usable ? 1 : 0);
			gl.activeTexture(gl.TEXTURE0 + unit);
			gl.bindTexture(gl.TEXTURE_2D, usable ? mesh[key] : null);
		});
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1f(u.metalness, source.metalness ?? (mesh.metalnessTexture ? 1 : 0));
		gl.uniform1f(u.roughness, source.roughness ?? 1);
		gl.uniform1f(u.useColors, source.colors ? 1 : 0);
		gl.uniform1f(u.hasNormals, source.normals ? 1 : 0);
		gl.uniform1f(u.alpha, alpha);
		gl.uniform1f(u.tintAmount, tintAmount);
		gl.bindVertexArray(mesh.vao);
		gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
	}

	render() {
		const gl = this.gl;
		this.resize();
		const { eye, viewProjection } = this.camera();
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clearColor(0.075, 0.078, 0.094, 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.useProgram(this.program);
		const u = this.uniforms;
		gl.uniformMatrix4fv(u.viewProjection, false, viewProjection);
		gl.uniform3f(u.eye, eye[0], eye[1], eye[2]);
		gl.uniform1f(u.flipV, this.data.flipV ? 1 : 0);
		gl.uniform1i(u.map, 0);
		gl.uniform3f(u.tint, 0.54, 0.71, 0.97);
		gl.uniform1f(u.idPass, 0);
		gl.enable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);
		gl.disable(gl.CULL_FACE);
		gl.depthMask(true);

		for (const mesh of this.meshes) {
			if (mesh.source.selected)
				this.drawMesh(mesh, 1, mesh.index === this.hover ? 0.2 : 0); // light enough not to change how the colors look
		}
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		// ground grid
		gl.uniform4f(u.color, 1, 1, 1, 1);
		for (const [, , flag] of MAPS)
			gl.uniform1f(u[flag], 0);
		gl.uniform1f(u.useColors, 0);
		gl.uniform1f(u.hasNormals, 0);
		gl.uniform1f(u.tintAmount, 1);
		gl.uniform3f(u.tint, 0.55, 0.58, 0.64);
		gl.uniform1f(u.alpha, 0.22);
		gl.bindVertexArray(this.grid.vao);
		gl.drawArrays(gl.LINES, 0, this.grid.count);
		// meshes that won't be downloaded stay visible as ghosts (not in the turntable video)
		gl.uniform3f(u.tint, 0.54, 0.71, 0.97);
		for (const mesh of this.meshes) {
			if (!mesh.source.selected && !this.recording)
				this.drawMesh(mesh, mesh.index === this.hover ? 0.5 : 0.14, mesh.index === this.hover ? 0.5 : 0);
		}
		gl.depthMask(true);
		gl.bindVertexArray(null);
	}

	/* Index of the mesh under a point of the canvas (CSS pixels), or -1. */
	pick(x, y) {
		const gl = this.gl;
		if (!gl)
			return -1;
		this.resize();
		const width = this.canvas.width, height = this.canvas.height;
		if (!this.pickTarget || this.pickTarget.width !== width || this.pickTarget.height !== height) {
			this.disposePickTarget();
			const framebuffer = gl.createFramebuffer();
			const color = gl.createRenderbuffer();
			gl.bindRenderbuffer(gl.RENDERBUFFER, color);
			gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
			const depth = gl.createRenderbuffer();
			gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
			gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
			this.pickTarget = { framebuffer, color, depth, width, height };
		}
		const { viewProjection, eye } = this.camera();
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickTarget.framebuffer);
		gl.viewport(0, 0, width, height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.useProgram(this.program);
		gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjection);
		gl.uniform3f(this.uniforms.eye, eye[0], eye[1], eye[2]);
		gl.uniform1f(this.uniforms.idPass, 1);
		gl.enable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);
		gl.depthMask(true);
		for (const mesh of this.meshes) {
			const id = mesh.index + 1;
			gl.uniform4f(this.uniforms.idColor, (id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255, 1);
			gl.bindVertexArray(mesh.vao);
			gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
		}
		const ratio = width / Math.max(1, this.canvas.clientWidth);
		const pixel = new Uint8Array(4);
		gl.readPixels(Math.floor(x * ratio), Math.floor(height - y * ratio - 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.bindVertexArray(null);
		gl.uniform1f(this.uniforms.idPass, 0);
		return (pixel[0] | pixel[1] << 8 | pixel[2] << 16) - 1;
	}

	/* Renders one mesh on its own, from the front right and a little above, at twice the size (drawn smaller it comes
	 * out smooth). Returns a 2D canvas to copy from right away, or null. */
	thumbnailCanvas(index, size) {
		const gl = this.gl, mesh = this.meshes[index];
		if (!gl || !mesh || !(mesh.lo[0] <= mesh.hi[0]))
			return null;
		const pixels = size * 2;
		if (!this.thumbTarget || this.thumbTarget.pixels !== pixels) {
			this.disposeThumbTarget();
			const framebuffer = gl.createFramebuffer();
			const color = gl.createRenderbuffer();
			gl.bindRenderbuffer(gl.RENDERBUFFER, color);
			gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, pixels, pixels);
			const depth = gl.createRenderbuffer();
			gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
			gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, pixels, pixels);
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
			const canvas = element('canvas');
			canvas.width = canvas.height = pixels;
			this.thumbTarget = { framebuffer, color, depth, pixels, canvas, context: canvas.getContext('2d'), image: new ImageData(pixels, pixels) };
		}
		const target = this.thumbTarget;
		if (!target.context)
			return null;
		const center = [0, 1, 2].map(k => (mesh.lo[k] + mesh.hi[k]) / 2);
		const radius = Math.max(Math.hypot(mesh.hi[0] - mesh.lo[0], mesh.hi[1] - mesh.lo[1], mesh.hi[2] - mesh.lo[2]) / 2, 1e-6);
		const fov = Math.PI / 6, yaw = 0.65, pitch = 0.4;
		const distance = radius / Math.sin(fov / 2) * 1.04;
		const eye = [center[0] + distance * Math.cos(pitch) * Math.sin(yaw), center[1] + distance * Math.sin(pitch),
			center[2] + distance * Math.cos(pitch) * Math.cos(yaw)];
		const viewProjection = multiply(perspective(fov, 1, distance / 100, distance * 3), lookAt(eye, center));
		gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
		gl.viewport(0, 0, pixels, pixels);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.useProgram(this.program);
		const u = this.uniforms;
		gl.uniformMatrix4fv(u.viewProjection, false, viewProjection);
		gl.uniform3f(u.eye, eye[0], eye[1], eye[2]);
		gl.uniform1f(u.flipV, this.data.flipV ? 1 : 0);
		gl.uniform1i(u.map, 0);
		gl.uniform1f(u.idPass, 0);
		gl.enable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);
		gl.disable(gl.CULL_FACE);
		gl.depthMask(true);
		this.drawMesh(mesh, 1, 0);
		const rows = new Uint8Array(pixels * pixels * 4);
		gl.readPixels(0, 0, pixels, pixels, gl.RGBA, gl.UNSIGNED_BYTE, rows);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.bindVertexArray(null);
		const stride = pixels * 4, data = target.image.data;
		for (let y = 0; y < pixels; y++)
			data.set(rows.subarray((pixels - 1 - y) * stride, (pixels - y) * stride), y * stride);
		target.context.putImageData(target.image, 0, 0);
		return target.canvas;
	}

	disposeThumbTarget() {
		if (!this.thumbTarget)
			return;
		const gl = this.gl;
		gl.deleteFramebuffer(this.thumbTarget.framebuffer);
		gl.deleteRenderbuffer(this.thumbTarget.color);
		gl.deleteRenderbuffer(this.thumbTarget.depth);
		this.thumbTarget = null;
	}

	disposePickTarget() {
		if (!this.pickTarget)
			return;
		const gl = this.gl;
		gl.deleteFramebuffer(this.pickTarget.framebuffer);
		gl.deleteRenderbuffer(this.pickTarget.color);
		gl.deleteRenderbuffer(this.pickTarget.depth);
		this.pickTarget = null;
	}

	dispose() {
		this.disposed = true;
		const gl = this.gl;
		if (!gl)
			return;
		this.disposePickTarget();
		this.disposeThumbTarget();
		for (const mesh of this.meshes) {
			gl.deleteVertexArray(mesh.vao);
			for (const buffer of mesh.buffers)
				gl.deleteBuffer(buffer);
		}
		for (const texture of this.glTextures)
			gl.deleteTexture(texture);
		for (const thumbnail of this.thumbnails)
			thumbnail.close();
		if (this.grid) {
			gl.deleteVertexArray(this.grid.vao);
			gl.deleteBuffer(this.grid.buffer);
		}
		gl.deleteProgram(this.program);
		const lose = gl.getExtension('WEBGL_lose_context');
		if (lose)
			lose.loseContext();
	}
}

/* ---- the preview overlay ---- */

const srgb = (c) => Math.pow(Math.min(Math.max(c, 0), 1), 1 / 2.2);

const THUMBNAIL_SIZE = 40; // CSS pixels

function drawThumbnail(canvas, view, entry, render) {
	const ratio = Math.min(window.devicePixelRatio || 1, 2);
	const size = Math.round(THUMBNAIL_SIZE * ratio);
	canvas.width = canvas.height = size;
	const context = canvas.getContext('2d');
	if (!context)
		return;
	const rendered = render && entry ? view.thumbnailCanvas(entry.index, size) : null;
	if (rendered) {
		context.drawImage(rendered, 0, 0, size, size);
		return;
	}
	if (entry && entry.bitmap) {
		context.drawImage(entry.bitmap, 0, 0, canvas.width, canvas.height);
		return;
	}
	const color = (entry && entry.source.color) || [0.6, 0.6, 0.62, 1];
	const channel = (c) => Math.round(srgb(c) * 255);
	context.fillStyle = `rgb(${channel(color[0])}, ${channel(color[1])}, ${channel(color[2])})`;
	context.fillRect(0, 0, canvas.width, canvas.height);
}

/* Turns the camera once around the selected meshes and records the canvas as WebM. */
function recordTurntable(view, canvas, onProgress, seconds = 6) {
	return new Promise((resolve, reject) => {
		const stream = canvas.captureStream(30);
		const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
		const recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 8000000 } : { videoBitsPerSecond: 8000000 });
		const chunks = [];
		recorder.ondataavailable = (event) => {
			if (event.data && event.data.size)
				chunks.push(event.data);
		};
		recorder.onerror = (event) => reject(event.error || new Error('recording failed'));
		recorder.onstop = () => {
			for (const track of stream.getTracks())
				track.stop();
			resolve(chunks.length ? new Blob(chunks, { type: 'video/webm' }) : null);
		};
		view.hover = -1;
		view.frame(false);
		view.recording = true;
		const yaw = view.yaw, start = performance.now();
		recorder.start(500);
		const step = () => {
			const t = Math.min(1, (performance.now() - start) / (seconds * 1000));
			view.yaw = yaw + t * Math.PI * 2;
			view.render();
			onProgress(Math.ceil(seconds * (1 - t)));
			if (t < 1 && !view.disposed) {
				native.requestAnimationFrame(step);
				return;
			}
			view.recording = false;
			view.yaw = yaw;
			recorder.stop();
		};
		native.requestAnimationFrame(step);
	});
}

function open(data) {
	return new Promise(resolve => {
		// Overlays can't be seen on top of a fullscreen element, and a locked pointer can't reach them
		try {
			if (document.fullscreenElement)
				document.exitFullscreen();
			if (document.pointerLockElement)
				document.exitPointerLock();
		} catch (err) {
			// not available in this frame
		}

		const { host, root } = createHost();
		const backdrop = element('div', 'backdrop');
		const stage = element('div', 'stage');
		const canvas = element('canvas');
		canvas.tabIndex = 0;
		append(stage, canvas, element('div', 'brand', t('WebGL Ripper · Preview')),
			element('div', 'help', t('Drag to orbit · right-drag or Shift-drag to pan · wheel to zoom · click a mesh to include or exclude it · double-click to frame')));
		const aside = element('aside');
		const header = element('header');
		const title = element('h1', '', t('{meshes} from {page}', { meshes: plural(data.meshes.length, 'mesh|meshes'), page: data.title }));
		const meta = element('div', 'meta');
		append(header, title, meta);
		const tools = element('div', 'tools');
		const allButton = element('button', '', t('All'));
		const noneButton = element('button', '', t('None'));
		const invertButton = element('button', '', t('Invert'));
		const frameButton = element('button', '', t('Frame'));
		const videoButton = element('button', '', t('Video'));
		videoButton.title = t('Record a 360° turntable of the selected meshes as a WebM video (V)');
		append(tools, allButton, noneButton, invertButton, frameButton, videoButton);
		const list = element('div', 'list');
		const formatLabel = element('div', 'section', t('Format'));
		const formats = element('div', 'format');
		const formatButtons = [['glb', 'GLB', 'One file with textures and materials'], ['obj', 'OBJ', 'OBJ, MTL and PNG files'],
			['both', 'GLB + OBJ', 'Both'], ['stl', 'STL', 'For 3D printing: geometry only'],
			['usdz', 'USDZ', 'For augmented reality on iPhone and iPad']].map(([value, label, tip]) => {
			const button = element('button', '', label);
			button.dataset.value = value;
			button.title = t(tip);
			append(formats, button);
			return button;
		});
		const compactLabel = element('label', 'compact');
		const compactBox = element('input');
		compactBox.type = 'checkbox';
		compactBox.checked = !!data.compact;
		append(compactLabel, compactBox, document.createTextNode(t('Smaller GLB (compressed geometry, JPEG textures)')));
		const actions = element('div', 'actions');
		const cancelButton = element('button', '', t('Cancel'));
		const downloadButton = element('button', 'primary', t('Download'));
		append(actions, cancelButton, downloadButton);
		append(aside, header, tools, list, formatLabel, formats, compactLabel, actions);
		append(backdrop, stage, aside);
		append(root, backdrop);

		const view = openView = new View(canvas, data);
		if (!view.gl)
			append(stage, element('div', 'fallback', t('3D preview is not available in this browser. The list still works.')));
		let format = data.format;
		const items = [];

		const refresh = () => {
			const selected = data.meshes.filter(mesh => mesh.selected);
			const triangles = selected.reduce((sum, mesh) => sum + mesh.triangleCount, 0);
			meta.textContent = t('{selected} selected · {triangles}', { selected: selected.length, triangles: plural(triangles, 'triangle|triangles') });
			downloadButton.textContent = selected.length ? t('Download {n}', { n: selected.length }) : t('Download');
			downloadButton.disabled = !selected.length;
			for (const [index, item] of items.entries()) {
				item.checkbox.checked = data.meshes[index].selected;
				item.row.classList.toggle('off', !data.meshes[index].selected);
				item.row.classList.toggle('hover', index === view.hover);
			}
			for (const button of formatButtons)
				button.classList.toggle('on', button.dataset.value === format);
			const glb = format === 'glb' || format === 'both';
			compactBox.disabled = !glb;
			compactLabel.classList.toggle('disabled', !glb);
			view.request();
		};
		const toggle = (index) => {
			if (index < 0 || index >= data.meshes.length)
				return;
			data.meshes[index].selected = !data.meshes[index].selected;
			refresh();
		};
		const setHover = (index) => {
			if (view.hover === index)
				return;
			view.hover = index;
			refresh();
		};

		// Rendered thumbnails are drawn a few at a time, for the rows that are (nearly) on screen
		const queue = new Set();
		let pumping = false;
		const pump = () => {
			pumping = false;
			if (view.disposed)
				return;
			const start = performance.now();
			for (const index of queue) {
				queue.delete(index);
				items[index].rendered = true;
				drawThumbnail(items[index].thumb, view, view.meshes[index], true);
				if (performance.now() - start > 8)
					break;
			}
			if (queue.size && !pumping) {
				pumping = true;
				native.requestAnimationFrame(pump);
			}
		};
		const wantThumbnail = (index) => {
			queue.add(index);
			if (!pumping) {
				pumping = true;
				native.requestAnimationFrame(pump);
			}
		};
		const rowObserver = view.gl && window.IntersectionObserver ? new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting)
					continue;
				rowObserver.unobserve(entry.target);
				wantThumbnail(Number(entry.target.dataset.index));
			}
		}, { root: list, rootMargin: '200px 0px' }) : null;

		for (const [index, mesh] of data.meshes.entries()) {
			const row = element('div', 'item');
			row.dataset.index = String(index);
			const checkbox = element('input');
			checkbox.type = 'checkbox';
			const thumb = element('canvas');
			const text = element('div', 'text');
			const name = element('div', 'name', mesh.name);
			if (mesh.picked)
				append(name, element('span', 'badge', t('picked')));
			else if (mesh.background)
				append(name, element('span', 'badge muted', t('background')));
			append(text, name, element('div', 'info', describeMesh(mesh, view.meshes[index])));
			append(row, checkbox, thumb, text);
			append(list, row);
			items.push({ row, checkbox, thumb, rendered: false });
			drawThumbnail(thumb, view, view.meshes[index], false);
			if (rowObserver)
				rowObserver.observe(row);
			else if (view.gl)
				wantThumbnail(index);
			row.addEventListener('click', (event) => {
				if (event.target !== checkbox)
					event.preventDefault();
				toggle(index);
			});
			row.addEventListener('mouseenter', () => setHover(index));
			row.addEventListener('mouseleave', () => setHover(-1));
		}
		view.onTexture = (entry) => {
			if (items[entry.index].rendered)
				wantThumbnail(entry.index);
			else
				drawThumbnail(items[entry.index].thumb, view, entry, false);
		};

		allButton.addEventListener('click', () => { data.meshes.forEach(m => { m.selected = true; }); refresh(); });
		noneButton.addEventListener('click', () => { data.meshes.forEach(m => { m.selected = false; }); refresh(); });
		invertButton.addEventListener('click', () => { data.meshes.forEach(m => { m.selected = !m.selected; }); refresh(); });
		frameButton.addEventListener('click', () => view.frame());
		let recording = false;
		const record = async () => {
			if (recording || !view.gl || typeof canvas.captureStream !== 'function' || typeof window.MediaRecorder !== 'function' ||
				!data.meshes.some(mesh => mesh.selected))
				return;
			recording = true;
			for (const button of [allButton, noneButton, invertButton, frameButton, videoButton, downloadButton])
				button.disabled = true;
			try {
				const blob = await recordTurntable(view, canvas, (left) => { videoButton.textContent = t('● {left} s', { left }); });
				if (blob && !closed) {
					const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
					registry.saveFile(`webglripper_${location.hostname || 'page'}_${stamp}_turntable.webm`, blob);
				}
			} catch (err) {
				// recording is not available here; the preview keeps working
			} finally {
				recording = false;
				videoButton.textContent = t('Video');
				for (const button of [allButton, noneButton, invertButton, frameButton, videoButton])
					button.disabled = false;
				refresh();
			}
		};
		videoButton.addEventListener('click', record);
		for (const button of formatButtons) {
			button.addEventListener('click', () => {
				format = button.dataset.value;
				refresh();
			});
		}

		// Camera: orbit, pan, zoom; a click without dragging toggles the mesh under the cursor
		let drag = null;
		let hoverTimer = 0;
		canvas.addEventListener('pointerdown', (event) => {
			canvas.setPointerCapture(event.pointerId);
			drag = { x: event.clientX, y: event.clientY, moved: false, pan: event.button === 2 || event.shiftKey };
			canvas.classList.add('dragging');
		});
		canvas.addEventListener('pointermove', (event) => {
			if (!drag) {
				if (!hoverTimer) {
					hoverTimer = native.setTimeout(() => {
						hoverTimer = 0;
						const rect = canvas.getBoundingClientRect();
						setHover(view.pick(event.clientX - rect.left, event.clientY - rect.top));
					}, 60);
				}
				return;
			}
			const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
			if (Math.abs(dx) + Math.abs(dy) > 3)
				drag.moved = true;
			drag.x = event.clientX;
			drag.y = event.clientY;
			if (drag.pan) {
				const { view: matrix } = view.camera();
				const speed = view.distance * 0.0016;
				for (let k = 0; k < 3; k++)
					view.target[k] += (-dx * matrix[k * 4] + dy * matrix[k * 4 + 1]) * speed;
			} else {
				view.yaw -= dx * 0.008;
				view.pitch = Math.min(Math.max(view.pitch + dy * 0.008, -1.5), 1.5);
			}
			view.request();
		});
		canvas.addEventListener('pointerup', (event) => {
			canvas.classList.remove('dragging');
			if (drag && !drag.moved && event.button === 0) {
				const rect = canvas.getBoundingClientRect();
				toggle(view.pick(event.clientX - rect.left, event.clientY - rect.top));
			}
			drag = null;
		});
		canvas.addEventListener('dblclick', () => view.frame());
		canvas.addEventListener('wheel', (event) => {
			event.preventDefault();
			view.distance *= Math.exp(Math.max(Math.min(event.deltaY, 200), -200) * 0.0015);
			view.request();
		}, { passive: false });
		canvas.addEventListener('contextmenu', (event) => event.preventDefault());

		const observer = native.ResizeObserver ? new native.ResizeObserver(() => view.request()) : null;
		if (observer)
			observer.observe(canvas);

		// Keep the page from reacting to what happens in the overlay
		for (const type of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick',
			'wheel', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'keydown', 'keyup', 'keypress'])
			host.addEventListener(type, (event) => event.stopPropagation());
		const onKey = (event) => {
			if (event.key === 'Escape' && !recording)
				close(null);
			else if (event.key === 'Enter' && !downloadButton.disabled)
				finish();
			else if ((event.key === 'v' || event.key === 'V') && !event.ctrlKey && !event.metaKey && !event.altKey)
				record();
			else
				return;
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		apply(native.addEventListener, window, ['keydown', onKey, true]);

		let closed = false;
		const close = (result) => {
			if (closed)
				return;
			closed = true;
			apply(native.removeEventListener, window, ['keydown', onKey, true]);
			if (observer)
				observer.disconnect();
			if (rowObserver)
				rowObserver.disconnect();
			native.clearTimeout(hoverTimer);
			if (openView === view)
				openView = null;
			view.dispose();
			host.remove();
			resolve(result);
		};
		const finish = () => close({
			selected: data.meshes.map((mesh, index) => (mesh.selected ? index : -1)).filter(index => index >= 0),
			format,
			compact: compactBox.checked
		});
		downloadButton.addEventListener('click', finish);
		cancelButton.addEventListener('click', () => close(null));

		refresh();
		canvas.focus();
	});
}

/* Maps read while the preview is open (normal, roughness, metalness): the engine hands them over mesh by mesh. */
function update(index, mesh) {
	const view = openView;
	const entry = view && view.gl && view.meshes[index];
	if (!entry || !mesh)
		return;
	for (const key of ['normalTexture', 'roughnessTexture', 'metalnessTexture', 'roughness', 'metalness']) {
		if (mesh[key] !== undefined)
			entry.source[key] = mesh[key];
	}
	entry.loading = Promise.resolve(entry.loading).then(() => view.loadMaps(entry));
}

/* Small rendered pictures of meshes (the popup lists what was saved): data: URLs, in the order given. */
async function thumbnails(meshes, flipV, size = 64) {
	if (!meshes.length)
		return [];
	const canvas = element('canvas');
	canvas.width = canvas.height = 1;
	const view = new View(canvas, { meshes, flipV, textureLimit: 256 });
	try {
		if (!view.gl)
			return [];
		await Promise.all(view.meshes.map(entry => entry.loading));
		const out = element('canvas');
		out.width = out.height = size;
		const context = out.getContext('2d');
		if (!context)
			return [];
		return view.meshes.map((entry, index) => {
			const rendered = view.thumbnailCanvas(index, size);
			if (!rendered)
				return null;
			context.clearRect(0, 0, size, size);
			context.drawImage(rendered, 0, 0, size, size);
			const url = out.toDataURL('image/webp', 0.9);
			return url.startsWith('data:image/webp') ? url : out.toDataURL('image/png');
		});
	} finally {
		view.dispose();
	}
}

registry.registerViewer({ open, hint, thumbnails, update });
})();
