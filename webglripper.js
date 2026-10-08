/*
 * WebGL Ripper - page engine.
 *
 * Runs in the page's MAIN world at document_start (see manifest.json). It hooks the WebGL API and, when asked,
 * records exactly one rendered frame and exports every triangle draw call as OBJ/MTL with PNG textures.
 *
 * The engine never touches extension APIs: settings and commands arrive from bridge.js as DOM events and
 * progress is reported back the same way. Everything lives inside this closure so nothing leaks into the
 * page's global scope.
 */
(function () {
'use strict';

const ENGINE_FLAG = Symbol.for('webglripper.engine');
if (window[ENGINE_FLAG])
	return;

// viewer.js, loaded right after this file, registers the preview and pick UI here. Its own canvas must not be
// mistaken for page content.
let viewerApi = null;
const ownCanvases = new WeakSet();
Object.defineProperty(window, ENGINE_FLAG, {
	value: Object.freeze({
		registerViewer(api) {
			if (!viewerApi && api)
				viewerApi = api;
		},
		ownCanvas(canvas) {
			ownCanvases.add(canvas);
		}
	})
});

const WebGL1 = window.WebGLRenderingContext;
const WebGL2 = window.WebGL2RenderingContext;
if (typeof WebGL1 !== 'function')
	return; // WebGL is disabled in this browser

const TO_PAGE = 'webglripper:page';
const TO_EXTENSION = 'webglripper:ext';
const CAPTURE_TIMEOUT_MS = 15000;
const WHOLE_BUFFER_READ_LIMIT = 64 * 1024 * 1024;

/* ------------------------------------------------------------------------------------------------------------
 * Built-ins captured before any page script runs, so later monkey patching by the page can't break us.
 * ---------------------------------------------------------------------------------------------------------- */

const apply = Reflect.apply;
const native = {
	requestAnimationFrame: window.requestAnimationFrame.bind(window),
	setTimeout: window.setTimeout.bind(window),
	clearTimeout: window.clearTimeout.bind(window),
	now: performance.now.bind(performance),
	createObjectURL: URL.createObjectURL.bind(URL),
	revokeObjectURL: URL.revokeObjectURL.bind(URL),
	dispatchEvent: EventTarget.prototype.dispatchEvent,
	addEventListener: EventTarget.prototype.addEventListener,
	removeEventListener: EventTarget.prototype.removeEventListener,
	elementsFromPoint: Document.prototype.elementsFromPoint,
	createElement: Document.prototype.createElement,
	appendChild: Node.prototype.appendChild,
	removeChild: Node.prototype.removeChild,
	click: HTMLElement.prototype.click,
	stringify: JSON.stringify,
	parse: JSON.parse,
	log: console.log.bind(console),
	info: console.info.bind(console),
	warn: console.warn.bind(console),
	CustomEvent: window.CustomEvent,
	Blob: window.Blob,
	Response: window.Response,
	CompressionStream: window.CompressionStream,
	TextEncoder: window.TextEncoder,
	MessageChannel: window.MessageChannel,
	postMessage: MessagePort.prototype.postMessage,
	setOnMessage: Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage').set
};

// Only set by tests/test.html before this script is loaded; pages can't reach it because we run first.
const testHook = window.__WEBGLRIPPER_TEST__ || null;

let debugEnabled = false;
const log = (...args) => { if (debugEnabled) native.log('[WebGLRipper]', ...args); };

class RipperError extends Error {}

/* ------------------------------------------------------------------------------------------------------------
 * WebGL constants. Numeric values so they can be used without a context.
 * ---------------------------------------------------------------------------------------------------------- */

const GL = {
	TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005, TRIANGLE_FAN: 0x0006,

	BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403,
	INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406, HALF_FLOAT: 0x140B, HALF_FLOAT_OES: 0x8D61,
	INT_2_10_10_10_REV: 0x8D9F, UNSIGNED_INT_2_10_10_10_REV: 0x8368,
	UNSIGNED_INT_10F_11F_11F_REV: 0x8C3B, UNSIGNED_INT_5_9_9_9_REV: 0x8C3E,

	ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
	ARRAY_BUFFER_BINDING: 0x8894, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
	COPY_READ_BUFFER: 0x8F36, COPY_WRITE_BUFFER: 0x8F37,
	UNIFORM_BUFFER: 0x8A11, UNIFORM_BUFFER_BINDING: 0x8A28, UNIFORM_BUFFER_START: 0x8A29,
	PIXEL_PACK_BUFFER: 0x88EB, PIXEL_UNPACK_BUFFER: 0x88EC,
	PIXEL_PACK_BUFFER_BINDING: 0x88ED, PIXEL_UNPACK_BUFFER_BINDING: 0x88EF,
	TRANSFORM_FEEDBACK_BUFFER: 0x8C8E, TRANSFORM_FEEDBACK_BUFFER_BINDING: 0x8C8F,
	BUFFER_SIZE: 0x8764, STATIC_DRAW: 0x88E4,

	CURRENT_PROGRAM: 0x8B8D, ACTIVE_UNIFORMS: 0x8B86, ACTIVE_ATTRIBUTES: 0x8B89, LINK_STATUS: 0x8B82,
	VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
	FLOAT_VEC3: 0x8B51, FLOAT_VEC4: 0x8B52, FLOAT_MAT4: 0x8B5C, SAMPLER_2D: 0x8B5E,
	UNIFORM_BLOCK_INDEX: 0x8A3A, UNIFORM_OFFSET: 0x8A3B, UNIFORM_ARRAY_STRIDE: 0x8A3C,
	UNIFORM_MATRIX_STRIDE: 0x8A3D, UNIFORM_IS_ROW_MAJOR: 0x8A3E, UNIFORM_BLOCK_BINDING: 0x8A3F,

	VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622, VERTEX_ATTRIB_ARRAY_SIZE: 0x8623, VERTEX_ATTRIB_ARRAY_STRIDE: 0x8624,
	VERTEX_ATTRIB_ARRAY_TYPE: 0x8625, VERTEX_ATTRIB_ARRAY_NORMALIZED: 0x886A, VERTEX_ATTRIB_ARRAY_POINTER: 0x8645,
	VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889F, VERTEX_ATTRIB_ARRAY_DIVISOR: 0x88FE, VERTEX_ATTRIB_ARRAY_INTEGER: 0x88FD,
	VERTEX_ARRAY_BINDING: 0x85B5,

	TEXTURE_2D: 0x0DE1, TEXTURE0: 0x84C0, ACTIVE_TEXTURE: 0x84E0, TEXTURE_BINDING_2D: 0x8069,
	MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_TEXTURE_SIZE: 0x0D33, SAMPLER_BINDING: 0x8919,
	TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
	NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812F,

	FRAMEBUFFER: 0x8D40, READ_FRAMEBUFFER: 0x8CA8, DRAW_FRAMEBUFFER: 0x8CA9,
	FRAMEBUFFER_BINDING: 0x8CA6, READ_FRAMEBUFFER_BINDING: 0x8CAA,
	COLOR_ATTACHMENT0: 0x8CE0, FRAMEBUFFER_COMPLETE: 0x8CD5,

	RGBA: 0x1908, RGB: 0x1907, ALPHA: 0x1906, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A, RGBA8: 0x8058,

	PACK_ALIGNMENT: 0x0D05, PACK_ROW_LENGTH: 0x0D02, PACK_SKIP_ROWS: 0x0D03, PACK_SKIP_PIXELS: 0x0D04,

	VIEWPORT: 0x0BA2, COLOR_WRITEMASK: 0x0C23,
	BLEND: 0x0BE2, CULL_FACE: 0x0B44, DEPTH_TEST: 0x0B71, STENCIL_TEST: 0x0B90, SCISSOR_TEST: 0x0C11,
	DITHER: 0x0BD0, POLYGON_OFFSET_FILL: 0x8037, SAMPLE_ALPHA_TO_COVERAGE: 0x809E, SAMPLE_COVERAGE: 0x80A0,
	RASTERIZER_DISCARD: 0x8C89, SAMPLES: 0x80A9,
	IMPLEMENTATION_COLOR_READ_TYPE: 0x8B9A, IMPLEMENTATION_COLOR_READ_FORMAT: 0x8B9B
};

const BUFFER_BINDING_FOR_TARGET = {
	[GL.ARRAY_BUFFER]: GL.ARRAY_BUFFER_BINDING,
	[GL.ELEMENT_ARRAY_BUFFER]: GL.ELEMENT_ARRAY_BUFFER_BINDING,
	[GL.COPY_READ_BUFFER]: GL.COPY_READ_BUFFER,   // the binding enums equal the target enums
	[GL.COPY_WRITE_BUFFER]: GL.COPY_WRITE_BUFFER,
	[GL.UNIFORM_BUFFER]: GL.UNIFORM_BUFFER_BINDING,
	[GL.PIXEL_PACK_BUFFER]: GL.PIXEL_PACK_BUFFER_BINDING,
	[GL.PIXEL_UNPACK_BUFFER]: GL.PIXEL_UNPACK_BUFFER_BINDING,
	[GL.TRANSFORM_FEEDBACK_BUFFER]: GL.TRANSFORM_FEEDBACK_BUFFER_BINDING
};

const INDEX_SIZE = { [GL.UNSIGNED_BYTE]: 1, [GL.UNSIGNED_SHORT]: 2, [GL.UNSIGNED_INT]: 4 };
const PRIMITIVE_RESTART = { [GL.UNSIGNED_BYTE]: 0xFF, [GL.UNSIGNED_SHORT]: 0xFFFF, [GL.UNSIGNED_INT]: 0xFFFFFFFF };
const MODE_NAMES = { [GL.TRIANGLES]: 'TRIANGLES', [GL.TRIANGLE_STRIP]: 'TRIANGLE_STRIP', [GL.TRIANGLE_FAN]: 'TRIANGLE_FAN' };

const COMPONENT_SIZE = {
	[GL.BYTE]: 1, [GL.UNSIGNED_BYTE]: 1, [GL.SHORT]: 2, [GL.UNSIGNED_SHORT]: 2,
	[GL.HALF_FLOAT]: 2, [GL.HALF_FLOAT_OES]: 2, [GL.INT]: 4, [GL.UNSIGNED_INT]: 4, [GL.FLOAT]: 4
};

const FLOAT_TEXEL_TYPES = new Set([GL.FLOAT, GL.HALF_FLOAT, GL.HALF_FLOAT_OES,
	GL.UNSIGNED_INT_10F_11F_11F_REV, GL.UNSIGNED_INT_5_9_9_9_REV]);
const FLOAT_FORMATS = new Set([0x822D, 0x822F, 0x881A, 0x881B, 0x822E, 0x8230, 0x8814, 0x8815, 0x8C3A, 0x8C3D]);
const UNRENDERABLE_FORMATS = new Set([GL.ALPHA, GL.LUMINANCE, GL.LUMINANCE_ALPHA, 0x8C40 /* SRGB_EXT */, 0x8C41 /* SRGB8 */]);
const DEPTH_FORMATS = new Set([0x1902, 0x84F9, 0x81A5, 0x81A6, 0x8CAC, 0x88F0, 0x8CAD]);
const SRGB_FORMATS = new Set([0x8C40, 0x8C41, 0x8C42, 0x8C43, 0x8C4C, 0x8C4D, 0x8C4E, 0x8C4F,
	0x9275, 0x9277, 0x9279, 0x8E8D,
	0x93D0, 0x93D1, 0x93D2, 0x93D3, 0x93D4, 0x93D5, 0x93D6, 0x93D7, 0x93D8, 0x93D9, 0x93DA, 0x93DB, 0x93DC, 0x93DD]);
const isIntegerFormat = (f) => (f >= 0x8231 && f <= 0x823C) || (f >= 0x8D70 && f <= 0x8D8F) || f === 0x906F;

const DRAW_CAPABILITIES = [GL.BLEND, GL.CULL_FACE, GL.DEPTH_TEST, GL.STENCIL_TEST, GL.SCISSOR_TEST, GL.DITHER,
	GL.POLYGON_OFFSET_FILL, GL.SAMPLE_ALPHA_TO_COVERAGE, GL.SAMPLE_COVERAGE, GL.RASTERIZER_DISCARD];

/* ------------------------------------------------------------------------------------------------------------
 * Native WebGL methods, called through a per-context facade so page-side wrappers never see our calls.
 * ---------------------------------------------------------------------------------------------------------- */

function snapshotMethods(proto) {
	const methods = Object.create(null);
	for (const name of Object.getOwnPropertyNames(proto)) {
		const desc = Object.getOwnPropertyDescriptor(proto, name);
		if (desc && typeof desc.value === 'function')
			methods[name] = desc.value;
	}
	return methods;
}

const NATIVE_1 = snapshotMethods(WebGL1.prototype);
const NATIVE_2 = typeof WebGL2 === 'function' ? snapshotMethods(WebGL2.prototype) : null;

const isWebGL2 = (gl) => !!NATIVE_2 && gl instanceof WebGL2;
const isWebGL = (obj) => obj instanceof WebGL1 || isWebGL2(obj);
const nativesOf = (gl) => (isWebGL2(gl) ? NATIVE_2 : NATIVE_1);
const callNative = (gl, name, args) => apply(nativesOf(gl)[name], gl, args);

function makeFacade(gl) {
	const methods = nativesOf(gl);
	const facade = Object.create(null);
	for (const name in methods) {
		const fn = methods[name];
		facade[name] = (...args) => apply(fn, gl, args);
	}
	return facade;
}

/* Wraps proto[name] so `after(thisArg, args, result)` runs after every call. The original is always called exactly
 * once with untouched arguments, and errors in our code are swallowed so they can never break the page.
 * Returns a function that puts the original back (used for hooks that only live during a capture). */
function hookMethod(proto, name, after) {
	const desc = proto && Object.getOwnPropertyDescriptor(proto, name);
	if (!desc || typeof desc.value !== 'function')
		return () => {};
	const wrapped = new Proxy(desc.value, {
		apply(target, self, args) {
			const result = apply(target, self, args);
			try {
				after(self, args, result);
			} catch (err) {
				log(`Hook for ${name} failed:`, err);
			}
			return result;
		}
	});
	Object.defineProperty(proto, name, { ...desc, value: wrapped });
	return () => {
		const current = Object.getOwnPropertyDescriptor(proto, name);
		if (current && current.value === wrapped)
			Object.defineProperty(proto, name, desc);
	};
}

/* ------------------------------------------------------------------------------------------------------------
 * Long-lived tracking (active from page load, kept as cheap as possible).
 * ---------------------------------------------------------------------------------------------------------- */

const knownContexts = new WeakSet();
const contextOfCanvas = new WeakMap();  // HTMLCanvasElement -> context, for pick mode
const contextRefs = [];                 // WeakRefs, so tracked contexts can still be garbage collected
const textureInfo = new WeakMap();      // WebGLTexture -> { width, height, internalFormat, type, compressed }
const bufferShadows = new WeakMap();    // WebGL 1 only: WebGLBuffer -> { size, bytes }
const extensionOwner = new WeakMap();   // extension object -> context
const instancingEnabled = new WeakSet();
const vertexArraysEnabled = new WeakSet(); // WebGL 1 contexts that enabled OES_vertex_array_object
const uniformLocations = new WeakMap(); // WebGLUniformLocation -> { program, base, index }
const renderTargetTextures = new WeakMap(); // texture the page renders into -> its framebuffer (post-processing buffers, shadow maps…)
const ownFramebuffers = new WeakSet();       // framebuffers WebGL Ripper uses to read textures back

let session = null;                     // active CaptureSession, only set while a frame is being recorded

function registerContext(gl) {
	if (knownContexts.has(gl))
		return;
	knownContexts.add(gl);
	contextRefs.push(new WeakRef(gl));
	if (gl.canvas instanceof HTMLCanvasElement)
		contextOfCanvas.set(gl.canvas, gl);
	log('Tracking new WebGL context', gl);
	scheduleContextsReport();
}

function liveContexts() {
	const live = [];
	for (let i = contextRefs.length - 1; i >= 0; i--) {
		const gl = contextRefs[i].deref();
		if (!gl) {
			contextRefs.splice(i, 1);
			continue;
		}
		if (!callNative(gl, 'isContextLost', []))
			live.unshift(gl);
	}
	return live;
}

/* Contexts that are attached to the document (detached ones are usually feature-detection probes). */
function visibleContextCount() {
	return liveContexts().filter(gl => {
		const canvas = gl.canvas;
		return !(canvas instanceof HTMLCanvasElement) || canvas.isConnected;
	}).length;
}

function imageSourceSize(source) {
	if (!source)
		return [0, 0];
	if (window.HTMLImageElement && source instanceof HTMLImageElement)
		return [source.naturalWidth || source.width, source.naturalHeight || source.height];
	if (window.HTMLVideoElement && source instanceof HTMLVideoElement)
		return [source.videoWidth, source.videoHeight];
	if (window.VideoFrame && source instanceof VideoFrame)
		return [source.displayWidth, source.displayHeight];
	return [source.width | 0, source.height | 0];
}

function trackBoundTexture(gl, info) {
	const texture = callNative(gl, 'getParameter', [GL.TEXTURE_BINDING_2D]);
	if (texture)
		textureInfo.set(texture, info);
}

function onTexImage2D(gl, args) {
	if (args[0] !== GL.TEXTURE_2D || args[1] !== 0)
		return; // only level 0 of 2D textures matters; mip levels would overwrite the real size
	if (args.length >= 8) {
		trackBoundTexture(gl, { width: args[3], height: args[4], internalFormat: args[2], type: args[7], compressed: false });
	} else if (args.length === 6) {
		const [width, height] = imageSourceSize(args[5]);
		trackBoundTexture(gl, { width, height, internalFormat: args[2], type: args[4], compressed: false });
	}
}

function toBytes(data) {
	if (data instanceof Uint8Array)
		return data;
	if (ArrayBuffer.isView(data))
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && data instanceof SharedArrayBuffer))
		return new Uint8Array(data);
	return null;
}

function boundBuffer(gl, target) {
	const binding = BUFFER_BINDING_FOR_TARGET[target];
	return binding ? callNative(gl, 'getParameter', [binding]) : null;
}

/* WebGL 1 can't read buffers back from the GPU, so we keep a private copy of everything that gets uploaded.
 * The data is copied because pages (notably Emscripten/Unity builds) reuse the source memory right away. */
function shadowedBuffer(gl, target) {
	if (target === GL.ARRAY_BUFFER)
		return apply(NATIVE_1.getParameter, gl, [GL.ARRAY_BUFFER_BINDING]);
	if (target === GL.ELEMENT_ARRAY_BUFFER)
		return apply(NATIVE_1.getParameter, gl, [GL.ELEMENT_ARRAY_BUFFER_BINDING]);
	return null;
}

function shadowBufferData(gl, target, data) {
	const buffer = shadowedBuffer(gl, target);
	if (!buffer)
		return;
	if (typeof data === 'number') {
		bufferShadows.set(buffer, { size: Math.max(0, Math.floor(data)), bytes: null }); // zero-filled, allocated lazily
		return;
	}
	const source = toBytes(data);
	if (!source)
		return;
	const shadow = bufferShadows.get(buffer);
	if (shadow && shadow.bytes && shadow.bytes.length === source.length)
		shadow.bytes.set(source);
	else
		bufferShadows.set(buffer, { size: source.length, bytes: source.slice() });
}

function shadowBufferSubData(gl, target, offset, data) {
	const buffer = shadowedBuffer(gl, target);
	const shadow = buffer && bufferShadows.get(buffer);
	const source = shadow && toBytes(data);
	if (!source)
		return;
	offset = Number(offset);
	if (!(offset >= 0) || offset + source.length > shadow.size)
		return; // the GL call failed with INVALID_VALUE, nothing changed on the GPU either
	if (!shadow.bytes)
		shadow.bytes = new Uint8Array(shadow.size);
	shadow.bytes.set(source, offset);
}

function onGetExtension(gl, args, extension) {
	if (!extension || typeof extension !== 'object')
		return;
	extensionOwner.set(extension, gl);
	if (/instanced_arrays$/i.test(String(args[0])))
		instancingEnabled.add(gl);
	if (/vertex_array_object$/i.test(String(args[0])))
		vertexArraysEnabled.add(gl);
}

function onGetUniformLocation(gl, args, location) {
	if (!location)
		return;
	const match = /^(.*)\[(\d+)\]$/.exec(String(args[1]));
	uniformLocations.set(location, { program: args[0], base: match ? match[1] : String(args[1]), index: match ? +match[2] : 0 });
}

/* getUniform is a synchronous round trip to the GPU process (hundreds of microseconds in Chrome), so during a
 * capture the values the page sets are recorded instead. These wrappers only exist while a frame is captured. */
function recordUniform(gl, location, size, data, offset, length, transpose) {
	const info = session && location && uniformLocations.get(location);
	if (!info || callNative(gl, 'getParameter', [GL.CURRENT_PROGRAM]) !== info.program)
		return;
	if (transpose && !isWebGL2(gl))
		return; // INVALID_VALUE in WebGL 1, the uniform keeps its old value
	const start = offset || 0;
	const end = length ? start + length : data.length;
	const store = session.uniformStore(info.program);
	for (let i = 0; start + (i + 1) * size <= end; i++) {
		const key = `${info.base}#${info.index + i}`;
		if (size === 1) {
			store.set(key, Number(data[start + i]));
		} else {
			const value = Float32Array.from(Array.prototype.slice.call(data, start + i * size, start + (i + 1) * size));
			store.set(key, transpose ? transpose4(value) : value);
		}
	}
}

const CAPTURE_UNIFORM_HOOKS = {
	uniform1i: (gl, a) => recordUniform(gl, a[0], 1, [a[1]]),
	uniform1iv: (gl, a) => recordUniform(gl, a[0], 1, a[1], a[2], a[3]),
	uniform3f: (gl, a) => recordUniform(gl, a[0], 3, [a[1], a[2], a[3]]),
	uniform3fv: (gl, a) => recordUniform(gl, a[0], 3, a[1], a[2], a[3]),
	uniform4f: (gl, a) => recordUniform(gl, a[0], 4, [a[1], a[2], a[3], a[4]]),
	uniform4fv: (gl, a) => recordUniform(gl, a[0], 4, a[1], a[2], a[3]),
	uniformMatrix4fv: (gl, a) => recordUniform(gl, a[0], 16, a[2], a[3], a[4], a[1])
};

/* Querying VERTEX_ATTRIB_ARRAY_DIVISOR, uniform block bindings and indexed buffer ranges are synchronous round
 * trips as well, so those are cached for the capture and kept current by watching the calls that change them. */
function recordDivisor(gl, index, divisor) {
	if (session && gl)
		session.context(gl).noteDivisor(index, divisor);
}

function recordUniformBufferRange(gl, target, index, offset) {
	if (session && target === GL.UNIFORM_BUFFER)
		session.context(gl).uniformBufferStarts.set(index, Number(offset) || 0);
}

const CAPTURE_WEBGL2_HOOKS = {
	vertexAttribDivisor: (gl, a) => recordDivisor(gl, a[0], a[1]),
	uniformBlockBinding: (gl, a) => { if (session) session.uniformStore(a[0]).set(`#block${a[1]}`, a[2]); },
	bindBufferBase: (gl, a) => recordUniformBufferRange(gl, a[0], a[1], 0),
	bindBufferRange: (gl, a) => recordUniformBufferRange(gl, a[0], a[1], a[3]),
	// resolving a multisampled target, or copying the scene to the canvas
	blitFramebuffer: (gl) => {
		if (session)
			session.feed(idOf(callNative(gl, 'getParameter', [GL.READ_FRAMEBUFFER_BINDING])), idOf(callNative(gl, 'getParameter', [GL.FRAMEBUFFER_BINDING])));
	}
};

const onDrawArrays = (gl, a) => { if (session) session.onDraw(gl, a[0], a[1], a[2], -1, 0); };
const onDrawElements = (gl, a) => { if (session) session.onDraw(gl, a[0], 0, a[1], a[2], a[3]); };
// WebGL 2 buffers are read back from the GPU during a capture; these only drop stale cached copies.
const onBufferChange = (gl, a) => { if (session) session.invalidateBuffer(gl, a[0]); };

/* Draw calls, and everything else that only matters while a frame is recorded, are hooked just for that frame: pages
 * don't pay for these hooks the rest of the time. Pages look the methods up on the prototype when they call them, so
 * hooks installed between two frames see the whole next frame. */
function installCaptureHooks(pick) {
	const restore = [];
	const hook = (proto, name, after) => restore.push(hookMethod(proto, name, after));
	for (const proto of [WebGL1.prototype, NATIVE_2 ? WebGL2.prototype : null]) {
		if (!proto)
			continue;
		hook(proto, 'drawArrays', onDrawArrays);
		hook(proto, 'drawElements', onDrawElements);
		for (const name in CAPTURE_UNIFORM_HOOKS)
			hook(proto, name, CAPTURE_UNIFORM_HOOKS[name]);
		if (pick) {
			// a cleared target gives the pixel under the cursor its starting value
			hook(proto, 'clear', (gl) => {
				if (session && session.pick && session.pick.gl === gl)
					session.context(gl).probe(null);
			});
		}
	}
	if (NATIVE_2) {
		const P2 = WebGL2.prototype;
		hook(P2, 'drawArraysInstanced', onDrawArrays);
		hook(P2, 'drawElementsInstanced', onDrawElements);
		hook(P2, 'drawRangeElements', (gl, a) => { if (session) session.onDraw(gl, a[0], 0, a[3], a[4], a[5]); });
		hook(P2, 'bufferData', onBufferChange);
		hook(P2, 'bufferSubData', onBufferChange);
		hook(P2, 'copyBufferSubData', (gl, a) => { if (session) session.invalidateBuffer(gl, a[1]); });
		for (const name in CAPTURE_WEBGL2_HOOKS)
			hook(P2, name, CAPTURE_WEBGL2_HOOKS[name]);
	}
	const Instanced = window.ANGLEInstancedArrays;
	if (typeof Instanced === 'function') {
		hook(Instanced.prototype, 'vertexAttribDivisorANGLE', (ext, a) => recordDivisor(extensionOwner.get(ext), a[0], a[1]));
		hook(Instanced.prototype, 'drawArraysInstancedANGLE', (ext, a) => {
			const gl = session && extensionOwner.get(ext);
			if (gl) session.onDraw(gl, a[0], a[1], a[2], -1, 0);
		});
		hook(Instanced.prototype, 'drawElementsInstancedANGLE', (ext, a) => {
			const gl = session && extensionOwner.get(ext);
			if (gl) session.onDraw(gl, a[0], 0, a[1], a[2], a[3]);
		});
	}
	const MultiDraw = window.WebGLMultiDraw;
	if (typeof MultiDraw === 'function') {
		const P = MultiDraw.prototype;
		hook(P, 'multiDrawArraysWEBGL', (ext, a) => onMultiDrawArrays(ext, a[0], a[1], a[2], a[3], a[4], a[5]));
		hook(P, 'multiDrawArraysInstancedWEBGL', (ext, a) => onMultiDrawArrays(ext, a[0], a[1], a[2], a[3], a[4], a[7]));
		hook(P, 'multiDrawElementsWEBGL', (ext, a) => onMultiDrawElements(ext, a[0], a[1], a[2], a[3], a[4], a[5], a[6]));
		hook(P, 'multiDrawElementsInstancedWEBGL', (ext, a) => onMultiDrawElements(ext, a[0], a[1], a[2], a[3], a[4], a[5], a[8]));
	}
	return () => restore.forEach(fn => fn());
}

function onMultiDrawArrays(ext, mode, firsts, firstsOffset, counts, countsOffset, drawCount) {
	const gl = session && extensionOwner.get(ext);
	if (!gl)
		return;
	for (let i = 0; i < drawCount; i++)
		session.onDraw(gl, mode, firsts[firstsOffset + i], counts[countsOffset + i], -1, 0);
}

function onMultiDrawElements(ext, mode, counts, countsOffset, type, offsets, offsetsOffset, drawCount) {
	const gl = session && extensionOwner.get(ext);
	if (!gl)
		return;
	for (let i = 0; i < drawCount; i++)
		session.onDraw(gl, mode, 0, counts[countsOffset + i], type, offsets[offsetsOffset + i]);
}

function installHooks() {
	const P1 = WebGL1.prototype;
	const P2 = NATIVE_2 ? WebGL2.prototype : null;

	const onGetContext = (canvas, args, context) => {
		if (context && isWebGL(context) && !ownCanvases.has(canvas))
			registerContext(context);
	};
	hookMethod(window.HTMLCanvasElement && HTMLCanvasElement.prototype, 'getContext', onGetContext);
	hookMethod(window.OffscreenCanvas && OffscreenCanvas.prototype, 'getContext', onGetContext);

	for (const proto of [P1, P2]) {
		if (!proto)
			continue;
		hookMethod(proto, 'texImage2D', onTexImage2D);
		hookMethod(proto, 'compressedTexImage2D', (gl, a) => {
			if (a[0] === GL.TEXTURE_2D && a[1] === 0)
				trackBoundTexture(gl, { width: a[3], height: a[4], internalFormat: a[2], type: 0, compressed: true });
		});
		hookMethod(proto, 'copyTexImage2D', (gl, a) => {
			if (a[0] === GL.TEXTURE_2D && a[1] === 0)
				trackBoundTexture(gl, { width: a[5], height: a[6], internalFormat: a[2], type: GL.UNSIGNED_BYTE, compressed: false });
		});
		hookMethod(proto, 'getExtension', onGetExtension);
		hookMethod(proto, 'getUniformLocation', onGetUniformLocation);
		hookMethod(proto, 'framebufferTexture2D', (gl, a) => {
			if (!a[3])
				return;
			const framebuffer = callNative(gl, 'getParameter', [a[0] === GL.READ_FRAMEBUFFER ? GL.READ_FRAMEBUFFER_BINDING : GL.FRAMEBUFFER_BINDING]);
			if (framebuffer && !ownFramebuffers.has(framebuffer))
				renderTargetTextures.set(a[3], framebuffer);
		});
	}

	if (P2) {
		hookMethod(P2, 'texStorage2D', (gl, a) => {
			if (a[0] === GL.TEXTURE_2D)
				trackBoundTexture(gl, { width: a[3], height: a[4], internalFormat: a[2], type: 0, compressed: false });
		});
	}

	// WebGL 1 can't read buffers back, so their contents are copied as they are uploaded
	hookMethod(P1, 'bufferData', (gl, a) => shadowBufferData(gl, a[0], a[1]));
	hookMethod(P1, 'bufferSubData', (gl, a) => shadowBufferSubData(gl, a[0], a[1], a[2]));
	hookMethod(P1, 'deleteBuffer', (gl, a) => { if (a[0]) bufferShadows.delete(a[0]); });
}

/* ------------------------------------------------------------------------------------------------------------
 * Name heuristics: which attribute is the position, which sampler is the diffuse texture, which uniform is the
 * model matrix. Engines name these very differently, so exact names from earlier releases are tried first and
 * a token based guess second. Users can add their own names in the options page.
 * ---------------------------------------------------------------------------------------------------------- */

const ATTRIBUTE_EXACT = {
	position: ['position', 'vertex', 'avertexposition', 's_attribute_0', 'avertex', 'vertex_position', 'aposition',
		'vposition', 'vertexposition', 'a_pos', 'a_position', 'in_position0', '_glesvertex', 'vertex_attrib'],
	normal: ['avertexnormal', 'normal', 's_attribute_1', 'vertex_normal', 'vnormal', 'vertexnormal', 'a_normal',
		'anormal', 'in_normal0', '_glesnormal', 'normal_attrib'],
	uv: ['uv', 'texcoord', 'texcoords', 'texcoord0', 'atexturecoord', 'vertex_texcoord0', 'vtexcoord', 'vertextexcoord',
		'a_uv', 'a_texcoord', 'a_texcoord0', 'atexcoord', 'in_texcoord0', '_glesmultitexcoord0', 'uv_attrib', 'uv0'],
	color: ['color', 'a_color', 'acolor', 'vertexcolor', 'vertex_color', 'avertexcolor', 'in_color0', '_glescolor',
		'color_attrib', 'color0']
};
const ATTRIBUTE_NOISE = new Set(['a', 'in', 'attr', 'attrib', 'attribute', 'gles', 'v', 'vs', 'i', 'input', 'multi']);
const ATTRIBUTE_REJECT = /^(prev|previous|next|high|low|dhigh|dlow|instance|instanced|offset|morph|target|tangent|bitangent|binormal|skin|weight|weights|joint|joints|bone|bones|blend|index|indices|id|barycentric|side|direction|velocity|life|age|start|end|center|centre|scale|rotation|quaternion|translation|matrix|matrices|world|model)$/;
const ATTRIBUTE_PATTERNS = [
	['position', /^(vertex)?(pos|position|positions|vertex|vertices|xyz)$/],
	['normal', /^(vertex)?(normal|normals|norm|nor|nrm)$/],
	['uv', /^(vertex)?(tex(ture)?coords?|uvs?|st|tc)$/],
	['color', /^(vertex)?(colou?rs?|col|rgba?)$/]
];

const LEGACY_DIFFUSE_SAMPLERS = new Set(['map', 'usampler', 'texture', 'albedosampler', 'source', 'utexture',
	'diffusesampler', 'ambientsampler', ...Array.from({ length: 32 }, (_, i) => `texture${i}`)]);

const MODEL_MATRIX_NAMES = new Set(['modelmatrix', 'model', 'world', 'worldmatrix', 'matrixmodel', 'unityobjecttoworld',
	'objecttoworld', 'modeltoworld', 'mmatrix', 'worldtransform', 'modeltransform', 'objectmatrix', 'modelmat']);
const MODEL_VIEW_MATRIX_NAMES = new Set(['modelviewmatrix', 'modelview', 'worldview', 'worldviewmatrix', 'mvmatrix',
	'matrixmodelview', 'mv', 'modelviewmat']);
const COLOR_UNIFORM_NAMES = {
	base: new Set(['diffuse', 'diffusecolor', 'vdiffusecolor', 'albedo', 'albedocolor', 'valbedocolor', 'basecolor',
		'basecolorfactor', 'color', 'maincolor', 'materialdiffuse', 'materialbasecolor', 'tint', 'tintcolor']),
	emissive: new Set(['emissive', 'emissivecolor', 'vemissivecolor', 'materialemissive', 'emission', 'emissioncolor'])
};

/* Returns 'base' | 'emissive' | null for vec3/vec4 uniforms that hold a material color. */
function classifyColorUniform(name) {
	// directionalLights[0].color and the like: the color of a light, not of the material
	const owner = String(name).match(/^(.*)\.[^.]*$/);
	if (owner && /light|lamp|fog|shadow|probe|env|sky/i.test(owner[1]))
		return null;
	const s = String(name).replace(/\[\d+\]$/, '').replace(/^.*\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
	const candidates = /^[um]./.test(s) ? [s, s.slice(1)] : [s];
	for (const role of ['base', 'emissive']) {
		if (candidates.some(c => COLOR_UNIFORM_NAMES[role].has(c)))
			return role;
	}
	return null;
}

const VIEW_MATRIX_NAMES = new Set(['viewmatrix', 'view', 'matrixview', 'unitymatrixv', 'cameraview', 'viewmat']);

function nameTokens(name) {
	return String(name)
		.replace(/\[\d+\]$/, '')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Za-z])(\d)/g, '$1 $2')
		.replace(/(\d)([A-Za-z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/* Returns [kind, score] or null. kind is position | normal | uv | color. */
function classifyAttribute(name, names) {
	const lower = String(name).toLowerCase();
	for (const kind of ['position', 'normal', 'uv', 'color']) {
		if (names[kind].includes(lower))
			return [kind, 3];
	}
	for (const kind of ['position', 'normal', 'uv', 'color']) {
		if (ATTRIBUTE_EXACT[kind].includes(lower))
			return [kind, 2];
	}
	const tokens = nameTokens(name).filter(t => !ATTRIBUTE_NOISE.has(t));
	if (tokens.some(t => ATTRIBUTE_REJECT.test(t)))
		return null;
	const digits = tokens.filter(t => /^\d+$/.test(t));
	if (digits.some(d => d !== '0'))
		return null; // secondary sets such as uv1 / color2 / position3D
	const joined = tokens.filter(t => !/^\d+$/.test(t)).join('');
	for (const [kind, pattern] of ATTRIBUTE_PATTERNS) {
		if (pattern.test(joined))
			return [kind, 1];
	}
	return null;
}

/* Returns [slot, priority]. slot is an MTL map name, 'extra', 'unknown' or 'exclude'. */
function classifyTexture(name, extraNames) {
	const lower = String(name).replace(/\[\d+\]$/, '').toLowerCase();
	const s = lower.replace(/[^a-z0-9]/g, '');
	const tokens = new Set(nameTokens(name));
	if (extraNames.includes(lower) || extraNames.includes(s))
		return ['map_Kd', 100];
	if (/shadow|depth|brdf|lut|irradiance|radiance|refract|transmission|noise|dither|bone|joint|morph|skin|jitter|ssao|gbuffer|backbuffer|framebuffer|accum|history|velocity|prefilter|sheen|iridescence|clearcoat|screen|scene|cube|probe|reflection|environment|envmap|envatlas/.test(s) || tokens.has('env'))
		return ['exclude', 0];
	if (LEGACY_DIFFUSE_SAMPLERS.has(s))
		return ['map_Kd', 40];
	if (/detail|occlu|lightmap|reflectivity|height|displace|parallax|matcap|gradient|mask|ramp|splat|control/.test(s) || tokens.has('ao'))
		return ['extra', 0];
	if (/normal|bump|nrm/.test(s) || tokens.has('nmap'))
		return ['map_Bump', 0];
	if (/metal/.test(s))
		return ['map_Pm', 0];
	if (/rough/.test(s))
		return ['map_Pr', 0];
	if (/emiss|emit|glow|illum/.test(s))
		return ['map_Ke', 0];
	if (/spec|gloss|smooth/.test(s))
		return ['map_Ks', 0];
	if (/alpha|opacity|transparen|cutout/.test(s))
		return ['map_d', 0];
	if (/diffuse|albedo|basecolou?r|maintex|basemap|colou?r(map|tex|texture|sampler)?$|^u?main|sprite|atlas/.test(s))
		return ['map_Kd', 50];
	if (/^[ust]?(map|tex|texture|sampler|image|img|source|src)\d*$/.test(s))
		return ['map_Kd', 30];
	return ['unknown', 10];
}

/* Returns 'model' | 'modelView' | 'view' | null. */
function classifyMatrix(name, extraNames) {
	const base = String(name).replace(/\[\d+\]$/, '').replace(/^.*\./, '').replace(/^hlslcc_mtx4x4/i, '');
	const s = base.toLowerCase().replace(/[^a-z0-9]/g, '');
	const candidates = /^[umg]./.test(s) ? [s, s.slice(1)] : [s];
	if (candidates.some(c => extraNames.includes(c)) || extraNames.includes(base.toLowerCase()))
		return 'model';
	if (candidates.some(c => MODEL_MATRIX_NAMES.has(c)))
		return 'model';
	if (candidates.some(c => MODEL_VIEW_MATRIX_NAMES.has(c)))
		return 'modelView';
	if (candidates.some(c => VIEW_MATRIX_NAMES.has(c)))
		return 'view';
	return null;
}

/* Picks one texture per MTL slot. The best diffuse candidate wins map_Kd; leftovers are kept as extras. */
function assignTextureSlots(found) {
	const ranked = found.slice().sort((a, b) => b.priority - a.priority);
	const diffuse = ranked.find(t => t.slot === 'map_Kd') || ranked.find(t => t.slot === 'unknown');
	const used = new Set();
	const seen = new Set();
	const result = [];
	for (const t of found) {
		let slot = t.slot;
		if (t === diffuse)
			slot = 'map_Kd';
		else if (slot === 'map_Kd' || slot === 'unknown' || used.has(slot))
			slot = 'extra';
		const key = `${slot}:${idOf(t.texture)}`;
		if (seen.has(key))
			continue;
		seen.add(key);
		if (slot !== 'extra')
			used.add(slot);
		result.push({ texture: t.texture, uniform: t.uniform, slot });
	}
	return result;
}

/* ------------------------------------------------------------------------------------------------------------
 * Geometry helpers.
 * ---------------------------------------------------------------------------------------------------------- */

let nextObjectId = 1;
const objectIds = new WeakMap();
function idOf(object) {
	if (!object)
		return 0;
	let id = objectIds.get(object);
	if (!id)
		objectIds.set(object, id = nextObjectId++);
	return id;
}

/* Expands any triangle primitive into a plain triangle list, honouring primitive restart and dropping
 * degenerate triangles (strips use them as joints). */
function triangulate(mode, indices, restartIndex) {
	const n = indices.length;
	const maxTriangles = mode === GL.TRIANGLES ? Math.floor(n / 3) : Math.max(0, n - 2);
	const out = new Uint32Array(maxTriangles * 3);
	let length = 0;
	const emit = (a, b, c) => {
		if (a !== b && b !== c && a !== c) {
			out[length++] = a;
			out[length++] = b;
			out[length++] = c;
		}
	};
	let start = 0;
	for (let i = 0; i <= n; i++) {
		if (i < n && indices[i] !== restartIndex)
			continue;
		if (mode === GL.TRIANGLES) {
			for (let j = start; j + 2 < i; j += 3)
				emit(indices[j], indices[j + 1], indices[j + 2]);
		} else if (mode === GL.TRIANGLE_STRIP) {
			for (let j = start; j + 2 < i; j++) {
				if ((j - start) & 1)
					emit(indices[j + 1], indices[j], indices[j + 2]);
				else
					emit(indices[j], indices[j + 1], indices[j + 2]);
			}
		} else if (mode === GL.TRIANGLE_FAN) {
			for (let j = start + 1; j + 1 < i; j++)
				emit(indices[start], indices[j], indices[j + 1]);
		}
		start = i + 1;
	}
	return out.subarray(0, length);
}

/* Keeps only the vertices that are actually referenced. Draw calls often use a small range of a big shared
 * buffer, and exporting the whole buffer for every draw call made files huge. */
function compactVertices(triangles) {
	let min = Infinity, max = -1;
	for (let i = 0; i < triangles.length; i++) {
		const v = triangles[i];
		if (v < min) min = v;
		if (v > max) max = v;
	}
	const remapped = new Uint32Array(triangles.length);
	const unique = [];
	const range = max - min + 1;
	if (range <= Math.max(triangles.length * 4, 65536)) {
		const lookup = new Int32Array(range).fill(-1);
		for (let i = 0; i < triangles.length; i++) {
			const slot = triangles[i] - min;
			let id = lookup[slot];
			if (id < 0) {
				id = lookup[slot] = unique.length;
				unique.push(triangles[i]);
			}
			remapped[i] = id;
		}
	} else {
		const lookup = new Map();
		for (let i = 0; i < triangles.length; i++) {
			let id = lookup.get(triangles[i]);
			if (id === undefined) {
				lookup.set(triangles[i], id = unique.length);
				unique.push(triangles[i]);
			}
			remapped[i] = id;
		}
	}
	return { remapped, unique: Uint32Array.from(unique), min, max };
}

function halfToFloat(h) {
	const sign = h & 0x8000 ? -1 : 1;
	const exponent = (h >> 10) & 0x1F;
	const fraction = h & 0x3FF;
	if (exponent === 0)
		return sign * fraction * 5.960464477539063e-8; // 2^-24
	if (exponent === 31)
		return fraction ? NaN : sign * Infinity;
	return sign * (1 + fraction / 1024) * Math.pow(2, exponent - 15);
}

function componentReader(type, normalized) {
	switch (type) {
		case GL.FLOAT: return (v, o) => v.getFloat32(o, true);
		case GL.HALF_FLOAT:
		case GL.HALF_FLOAT_OES: return (v, o) => halfToFloat(v.getUint16(o, true));
		case GL.BYTE: return normalized ? (v, o) => Math.max(v.getInt8(o) / 127, -1) : (v, o) => v.getInt8(o);
		case GL.UNSIGNED_BYTE: return normalized ? (v, o) => v.getUint8(o) / 255 : (v, o) => v.getUint8(o);
		case GL.SHORT: return normalized ? (v, o) => Math.max(v.getInt16(o, true) / 32767, -1) : (v, o) => v.getInt16(o, true);
		case GL.UNSIGNED_SHORT: return normalized ? (v, o) => v.getUint16(o, true) / 65535 : (v, o) => v.getUint16(o, true);
		case GL.INT: return normalized ? (v, o) => Math.max(v.getInt32(o, true) / 2147483647, -1) : (v, o) => v.getInt32(o, true);
		case GL.UNSIGNED_INT: return normalized ? (v, o) => v.getUint32(o, true) / 4294967295 : (v, o) => v.getUint32(o, true);
		default: return null;
	}
}

function decodePacked1010102(word, signed, normalized, out) {
	if (signed) {
		const x = (word << 22) >> 22, y = (word << 12) >> 22, z = (word << 2) >> 22, w = word >> 30;
		out[0] = normalized ? Math.max(x / 511, -1) : x;
		out[1] = normalized ? Math.max(y / 511, -1) : y;
		out[2] = normalized ? Math.max(z / 511, -1) : z;
		out[3] = normalized ? Math.max(w, -1) : w;
	} else {
		const x = word & 0x3FF, y = (word >>> 10) & 0x3FF, z = (word >>> 20) & 0x3FF, w = word >>> 30;
		out[0] = normalized ? x / 1023 : x;
		out[1] = normalized ? y / 1023 : y;
		out[2] = normalized ? z / 1023 : z;
		out[3] = normalized ? w / 3 : w;
	}
}

/* ---- 4x4 matrices, column-major like WebGL ---- */

function multiply4(a, b) {
	const out = new Float64Array(16);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			let sum = 0;
			for (let k = 0; k < 4; k++)
				sum += a[k * 4 + r] * b[c * 4 + k];
			out[c * 4 + r] = sum;
		}
	}
	return out;
}

function transpose4(m) {
	const out = new Float32Array(16);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++)
			out[c * 4 + r] = m[r * 4 + c];
	return out;
}

function invert4(m) {
	const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
	const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
	const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
	const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
	const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (!det || !Number.isFinite(det))
		return null;
	const d = 1 / det;
	return Float64Array.of(
		(a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
		(a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
		(a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
		(a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
		(a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
		(a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
		(a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
		(a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d);
}

/* Inverse-transpose of the upper 3x3, returned column-major as 9 numbers. */
function normalMatrix(m) {
	const a00 = m[0], a01 = m[1], a02 = m[2], a10 = m[4], a11 = m[5], a12 = m[6], a20 = m[8], a21 = m[9], a22 = m[10];
	const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
	const det = a00 * b01 + a01 * b11 + a02 * b21;
	if (!det || !Number.isFinite(det))
		return null;
	const d = 1 / det;
	// inverse (column-major) ...
	const inv = [b01 * d, (-a22 * a01 + a02 * a21) * d, (a12 * a01 - a02 * a11) * d,
		b11 * d, (a22 * a00 - a02 * a20) * d, (-a12 * a00 + a02 * a10) * d,
		b21 * d, (-a21 * a00 + a01 * a20) * d, (a11 * a00 - a01 * a10) * d];
	// ... transposed
	return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
}

function transformPositions(positions, m) {
	for (let i = 0; i < positions.length; i += 3) {
		const x = positions[i], y = positions[i + 1], z = positions[i + 2];
		let w = m[3] * x + m[7] * y + m[11] * z + m[15];
		if (!w || Math.abs(w - 1) < 1e-6)
			w = 1;
		positions[i] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
		positions[i + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
		positions[i + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
	}
}

function transformNormals(normals, n) {
	for (let i = 0; i < normals.length; i += 3) {
		const x = normals[i], y = normals[i + 1], z = normals[i + 2];
		const nx = n[0] * x + n[3] * y + n[6] * z;
		const ny = n[1] * x + n[4] * y + n[7] * z;
		const nz = n[2] * x + n[5] * y + n[8] * z;
		const length = Math.hypot(nx, ny, nz) || 1;
		normals[i] = nx / length;
		normals[i + 1] = ny / length;
		normals[i + 2] = nz / length;
	}
}

/* ------------------------------------------------------------------------------------------------------------
 * Capture: one session records one frame across every WebGL context of this document.
 * ---------------------------------------------------------------------------------------------------------- */

function splitNames(value) {
	return String(value || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

function normalizeSettings(raw) {
	raw = raw || {};
	const [width, height] = String(raw.default_texture_res || '4096x4096').split('x').map(n => parseInt(n, 10));
	return {
		zip: raw.should_download_zip !== false,
		layout: ['separate', 'combined', 'both'].includes(raw.export_layout) ? raw.export_layout : 'separate',
		applyMatrix: raw.do_model_view_matrix !== false,
		unflip: raw.unflip_textures !== false,
		skipDuplicates: raw.skip_duplicates !== false,
		skipOverlays: raw.skip_overlays !== false,
		weldVertices: raw.weld_vertices !== false,
		vertexColors: raw.export_vertex_colors !== false,
		format: ['glb', 'obj', 'both'].includes(raw.export_format) ? raw.export_format : 'glb',
		preview: raw.show_preview !== false,
		center: raw.center_model !== false,
		computeNormals: raw.compute_normals !== false,
		fallbackWidth: width > 0 ? width : 4096,
		fallbackHeight: height > 0 ? height : 4096,
		names: {
			position: splitNames(raw.extra_position_names),
			normal: splitNames(raw.extra_normal_names),
			uv: splitNames(raw.extra_uv_names),
			color: [],
			texture: splitNames(raw.extra_texture_names).map(n => n.replace(/[^a-z0-9_]/g, '')),
			matrix: splitNames(raw.extra_matrix_names).map(n => n.replace(/[^a-z0-9_]/g, '').replace(/_/g, ''))
		}
	};
}

class CaptureSession {
	constructor(settings) {
		this.settings = settings;
		this.contexts = new Map();       // gl -> ContextCapture
		this.meshes = [];
		this.exactKeys = new Map();      // draw signature -> mesh, for skipping repeated draws
		this.drawCount = 0;
		this.stats = { unsupportedMode: 0, noPosition: 0, duplicates: 0, overlays: 0, unreadable: 0, errors: 0 };
		this.unrecognizedAttributes = new Set();
		this.targets = new Map();        // framebuffer id -> { draws, last }: how many draw calls, and the last one
		this.feeds = new Map();          // framebuffer id -> ids of the framebuffers whose textures were sampled into it
		this.uniforms = new Map();       // program -> Map("name#element" -> value) set during this capture
		this.removeHooks = () => {};
		this.pick = null;                // { gl, x, y } in pick mode, 0..1 from the bottom left of the canvas
		this.startedAt = 0;
	}

	/* The contents of framebuffer `source` went into framebuffer `target`: sampled as a texture, or blitted. */
	feed(source, target) {
		if (source === target)
			return;
		let sources = this.feeds.get(target);
		if (!sources)
			this.feeds.set(target, sources = new Set());
		sources.add(source);
	}

	uniformStore(program) {
		let store = this.uniforms.get(program);
		if (!store)
			this.uniforms.set(program, store = new Map());
		return store;
	}

	context(gl) {
		let context = this.contexts.get(gl);
		if (!context)
			this.contexts.set(gl, context = new ContextCapture(this, gl, this.contexts.size));
		return context;
	}

	onDraw(gl, mode, first, count, indexType, indexOffset) {
		this.drawCount++;
		try {
			if (callNative(gl, 'isContextLost', []))
				return;
			const context = this.context(gl);
			const mesh = context.captureDraw(mode, first, count, indexType, indexOffset);
			if (this.pick && this.pick.gl === gl)
				context.probe(mesh);
		} catch (err) {
			this.stats.errors++;
			log('Failed to capture a draw call:', err);
		}
	}

	invalidateBuffer(gl, target) {
		const context = this.contexts.get(gl);
		if (context)
			context.bufferCache.delete(boundBuffer(gl, target));
	}
}

class ContextCapture {
	constructor(session, gl, index) {
		this.session = session;
		this.gl = gl;
		this.index = index;
		this.webgl2 = isWebGL2(gl);
		this.g = makeFacade(gl);
		this.programs = new Map();
		this.bufferCache = new Map();
		this.instancing = this.webgl2 || instancingEnabled.has(gl);  // whether divisors can be non-zero
		this.maxTextureUnits = this.g.getParameter(GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS) || 8;
		this.divisors = new Map();       // "vertexArray:location" -> divisor
		this.uniformBufferStarts = new Map(); // uniform buffer binding point -> offset, as bound during the capture
		this.pickPixels = new Map();     // render target -> last value of the pixel under the cursor
		this.readTypes = new Map();      // render target -> readPixels type, 0 when it can't be read
		this.unreadableTargets = new Set();
		this.reader = null;
		this.vaoExtension = undefined;
	}

	vertexArrayId() {
		if (this.webgl2 || vertexArraysEnabled.has(this.gl))
			return idOf(this.g.getParameter(GL.VERTEX_ARRAY_BINDING));
		return 0;
	}

	noteDivisor(location, divisor) {
		this.divisors.set(`${this.vertexArrayId()}:${location}`, divisor);
	}

	divisor(location) {
		if (!this.instancing)
			return 0;
		const key = `${this.vertexArrayId()}:${location}`;
		let divisor = this.divisors.get(key);
		if (divisor === undefined)
			this.divisors.set(key, divisor = this.g.getVertexAttrib(location, GL.VERTEX_ATTRIB_ARRAY_DIVISOR) || 0);
		return divisor;
	}

	/* WebGL 1 only: OES_vertex_array_object, needed to draw without disturbing the page's vertex state. */
	vertexArrayExtension() {
		if (this.vaoExtension === undefined)
			this.vaoExtension = this.g.getExtension('OES_vertex_array_object') || null;
		return this.vaoExtension;
	}

	describe() {
		const canvas = this.gl.canvas;
		return {
			index: this.index,
			api: this.webgl2 ? 'webgl2' : 'webgl',
			width: this.gl.drawingBufferWidth,
			height: this.gl.drawingBufferHeight,
			canvas: canvas instanceof HTMLCanvasElement ? (canvas.id ? `#${canvas.id}` : 'canvas') : 'OffscreenCanvas'
		};
	}

	/* ---- program reflection (cached per capture) ---- */

	programInfo(program) {
		let info = this.programs.get(program);
		if (info)
			return info;
		const g = this.g;
		const names = this.session.settings.names;
		info = { attribs: {}, attributeNames: [], samplers: [], colors: {}, model: null, modelView: null, view: null };

		const attributeCount = g.getProgramParameter(program, GL.ACTIVE_ATTRIBUTES) || 0;
		for (let i = 0; i < attributeCount; i++) {
			const active = g.getActiveAttrib(program, i);
			if (!active)
				continue;
			const location = g.getAttribLocation(program, active.name);
			if (location < 0)
				continue; // built-ins such as gl_VertexID
			info.attributeNames.push(active.name);
			const match = classifyAttribute(active.name, names);
			if (!match)
				continue;
			const [kind, score] = match;
			if (!info.attribs[kind] || score > info.attribs[kind].score)
				info.attribs[kind] = { name: active.name, location, score };
		}

		const uniformCount = g.getProgramParameter(program, GL.ACTIVE_UNIFORMS) || 0;
		for (let i = 0; i < uniformCount; i++) {
			const active = g.getActiveUniform(program, i);
			if (!active)
				continue;
			if (active.type === GL.SAMPLER_2D) {
				const location = g.getUniformLocation(program, active.name);
				if (!location)
					continue;
				const name = active.name.replace(/\[0\]$/, '');
				const [slot, priority] = classifyTexture(name, names.texture);
				// excluded samplers (shadow maps, previous passes…) still tell which render targets feed which
				info.samplers.push({ name, location, slot, priority });
				continue;
			}
			if (active.type === GL.FLOAT_VEC3 || (active.type === GL.FLOAT_VEC4 && active.size === 1)) {
				const role = classifyColorUniform(active.name);
				const location = role && !info.colors[role] && g.getUniformLocation(program, active.name);
				if (location)
					info.colors[role] = { location, base: active.name.replace(/\[0\]$/, '') };
				continue;
			}
			if (active.type !== GL.FLOAT_MAT4 && !(active.type === GL.FLOAT_VEC4 && active.size >= 4))
				continue;
			const role = classifyMatrix(active.name, names.matrix);
			if (!role || info[role])
				continue;
			const source = this.matrixSource(program, active, i);
			if (source)
				info[role] = { ...source, name: active.name, base: active.name.replace(/\[0\]$/, '') };
		}

		this.programs.set(program, info);
		return info;
	}

	matrixSource(program, active, index) {
		const g = this.g;
		if (active.type === GL.FLOAT_MAT4) {
			const location = g.getUniformLocation(program, active.name);
			if (location)
				return { kind: 'mat4', location };
		} else {
			// hlslcc (Unity) stores matrices as vec4 arrays: hlslcc_mtx4x4unity_ObjectToWorld[4]
			const base = active.name.replace(/\[0\]$/, '');
			const locations = [0, 1, 2, 3].map(j => g.getUniformLocation(program, `${base}[${j}]`));
			if (locations.every(Boolean))
				return { kind: 'columns', locations };
		}
		if (!this.webgl2)
			return null;
		const [block] = g.getActiveUniforms(program, [index], GL.UNIFORM_BLOCK_INDEX);
		if (!(block >= 0))
			return null;
		const [offset] = g.getActiveUniforms(program, [index], GL.UNIFORM_OFFSET);
		const strideQuery = active.type === GL.FLOAT_MAT4 ? GL.UNIFORM_MATRIX_STRIDE : GL.UNIFORM_ARRAY_STRIDE;
		const [stride] = g.getActiveUniforms(program, [index], strideQuery);
		const [rowMajor] = g.getActiveUniforms(program, [index], GL.UNIFORM_IS_ROW_MAJOR);
		return { kind: 'block', block, offset, stride: stride || 16, rowMajor: !!rowMajor };
	}

	/* Value set by the page during this capture, or else the (slow) GL query. Sampler units rarely change, so
	 * those are remembered; matrices are queried again on every draw unless the page set them in this frame. */
	uniformValue(program, base, index, location, remember) {
		const store = this.session.uniformStore(program);
		const key = `${base}#${index}`;
		if (store.has(key))
			return store.get(key);
		let value = this.g.getUniform(program, location);
		if (value && typeof value === 'object')
			value = Float32Array.from(value);
		if (remember)
			store.set(key, value);
		return value;
	}

	readColor(program, source) {
		if (!source)
			return null;
		const value = this.uniformValue(program, source.base, 0, source.location, false);
		if (!value || !(value.length >= 3))
			return null;
		return [value[0], value[1], value[2], value.length > 3 ? value[3] : 1].map(c => (Number.isFinite(c) ? c : 0));
	}

	readMatrix(program, source) {
		const g = this.g;
		let m = null;
		if (source.kind === 'mat4') {
			const value = this.uniformValue(program, source.base, 0, source.location, false);
			if (value && value.length === 16)
				m = Float32Array.from(value);
		} else if (source.kind === 'columns') {
			m = new Float32Array(16);
			for (let c = 0; c < 4; c++) {
				const column = this.uniformValue(program, source.base, c, source.locations[c], false);
				if (!column || column.length < 4)
					return null;
				m.set(Array.prototype.slice.call(column, 0, 4), c * 4);
			}
		} else {
			const store = this.session.uniformStore(program);
			let binding = store.get(`#block${source.block}`);
			if (binding === undefined)
				store.set(`#block${source.block}`, binding = g.getActiveUniformBlockParameter(program, source.block, GL.UNIFORM_BLOCK_BINDING));
			const buffer = g.getIndexedParameter(GL.UNIFORM_BUFFER_BINDING, binding);
			if (!buffer)
				return null;
			let start = this.uniformBufferStarts.get(binding);
			if (start === undefined)
				this.uniformBufferStarts.set(binding, start = Number(g.getIndexedParameter(GL.UNIFORM_BUFFER_START, binding)) || 0);
			const length = source.stride * 3 + 16;
			const bytes = this.readBuffer(buffer, start + source.offset, length);
			if (!bytes || bytes.length < length)
				return null;
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			m = new Float32Array(16);
			for (let c = 0; c < 4; c++)
				for (let r = 0; r < 4; r++)
					m[c * 4 + r] = view.getFloat32(c * source.stride + r * 4, true);
			if (source.rowMajor)
				m = transpose4(m);
		}
		return m && m.every(Number.isFinite) ? m : null;
	}

	/* Returns { kind: 'model' | 'modelView', m, view } describing how to bring this draw into world space. view is the
	 * camera of this draw when it could be found; modelView-only meshes are resolved with it after the capture. */
	drawMatrix(program, info) {
		let view = info.view ? this.readMatrix(program, info.view) : null;
		const model = info.model ? this.readMatrix(program, info.model) : null;
		const modelView = info.modelView ? this.readMatrix(program, info.modelView) : null;
		if (!view && model && modelView) {
			// view = modelView * inverse(model): lets modelView-only programs (three.js) be placed in world space
			const inverseModel = invert4(model);
			if (inverseModel)
				view = Float32Array.from(multiply4(modelView, inverseModel));
		}
		if (model)
			return { kind: 'model', m: model, view };
		if (modelView) {
			const inverseView = view && invert4(view);
			if (inverseView)
				return { kind: 'model', m: Float32Array.from(multiply4(inverseView, modelView)), view };
			return { kind: 'modelView', m: modelView, view: null };
		}
		return view ? { kind: 'none', m: null, view } : null;
	}

	/* ---- vertex attribute and buffer access ---- */

	attribState(location) {
		const g = this.g;
		if (!g.getVertexAttrib(location, GL.VERTEX_ATTRIB_ARRAY_ENABLED))
			return null;
		const buffer = g.getVertexAttrib(location, GL.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
		if (!buffer)
			return null;
		if (this.divisor(location))
			return null; // per-instance data, not per-vertex
		const integer = this.webgl2 && g.getVertexAttrib(location, GL.VERTEX_ATTRIB_ARRAY_INTEGER);
		return {
			buffer,
			size: g.getVertexAttrib(location, GL.VERTEX_ATTRIB_ARRAY_SIZE),
			type: g.getVertexAttrib(location, GL.VERTEX_ATTRIB_ARRAY_TYPE),
			normalized: !integer && !!g.getVertexAttrib(location, GL.VERTEX_ATTRIB_ARRAY_NORMALIZED),
			stride: g.getVertexAttrib(location, GL.VERTEX_ATTRIB_ARRAY_STRIDE),
			offset: g.getVertexAttribOffset(location, GL.VERTEX_ATTRIB_ARRAY_POINTER)
		};
	}

	gpuRead(buffer, offset, length, wholeLimit) {
		const g = this.g;
		const previous = g.getParameter(GL.COPY_READ_BUFFER);
		g.bindBuffer(GL.COPY_READ_BUFFER, buffer);
		try {
			const size = g.getBufferParameter(GL.COPY_READ_BUFFER, GL.BUFFER_SIZE) || 0;
			if (wholeLimit !== undefined && size > wholeLimit)
				return null;
			const start = Math.min(Math.max(0, offset), size);
			const count = Math.max(0, Math.min(length, size - start));
			const out = new Uint8Array(count);
			if (count > 0)
				g.getBufferSubData(GL.COPY_READ_BUFFER, start, out);
			return out;
		} finally {
			g.bindBuffer(GL.COPY_READ_BUFFER, previous);
		}
	}

	readBuffer(buffer, start, length) {
		start = Math.max(0, Math.floor(start));
		length = Math.max(0, Math.floor(length));
		if (!this.webgl2) {
			const shadow = bufferShadows.get(buffer);
			if (!shadow)
				return null;
			const end = Math.min(start + length, shadow.size);
			if (!shadow.bytes)
				return new Uint8Array(Math.max(0, end - start));
			return shadow.bytes.subarray(Math.min(start, end), end);
		}
		let cached = this.bufferCache.get(buffer);
		if (!cached) {
			cached = { bytes: this.gpuRead(buffer, 0, Infinity, WHOLE_BUFFER_READ_LIMIT) };
			this.bufferCache.set(buffer, cached);
		}
		if (cached.bytes) {
			const end = Math.min(start + length, cached.bytes.length);
			return cached.bytes.subarray(Math.min(start, end), end);
		}
		return this.gpuRead(buffer, start, length); // too big to cache, read just the range
	}

	readIndices(buffer, type, offset, count) {
		const size = INDEX_SIZE[type];
		if (!size)
			return null;
		const bytes = this.readBuffer(buffer, offset, count * size);
		if (!bytes)
			return null;
		const n = Math.floor(bytes.length / size);
		if (size === 1)
			return Uint32Array.from(bytes);
		const out = new Uint32Array(n);
		if (bytes.byteOffset % size === 0) {
			out.set(size === 2 ? new Uint16Array(bytes.buffer, bytes.byteOffset, n) : new Uint32Array(bytes.buffer, bytes.byteOffset, n));
		} else {
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			for (let i = 0; i < n; i++)
				out[i] = size === 2 ? view.getUint16(i * 2, true) : view.getUint32(i * 4, true);
		}
		return out;
	}

	/* Decodes `components` floats per vertex for the given (sorted by first use) vertex ids. */
	readAttribute(attr, vertices, minVertex, maxVertex, components) {
		const packed = attr.type === GL.INT_2_10_10_10_REV || attr.type === GL.UNSIGNED_INT_2_10_10_10_REV;
		const componentSize = packed ? 4 : COMPONENT_SIZE[attr.type];
		const reader = packed ? null : componentReader(attr.type, attr.normalized);
		if (!componentSize || (!packed && !reader))
			return null;
		const elementSize = packed ? 4 : componentSize * attr.size;
		const stride = attr.stride || elementSize;
		const start = attr.offset + minVertex * stride;
		const bytes = this.readBuffer(attr.buffer, start, (maxVertex - minVertex) * stride + elementSize);
		if (!bytes)
			return null;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const out = new Float32Array(vertices.length * components);
		const readable = Math.min(components, packed ? 4 : attr.size);
		const unpacked = new Float32Array(4);
		for (let i = 0; i < vertices.length; i++) {
			const base = (vertices[i] - minVertex) * stride;
			if (base + elementSize > bytes.length)
				continue; // out of range: the GPU would have read zeros (or failed the draw)
			if (packed) {
				decodePacked1010102(view.getUint32(base, true), attr.type === GL.INT_2_10_10_10_REV, attr.normalized, unpacked);
				for (let c = 0; c < readable; c++)
					out[i * components + c] = unpacked[c];
			} else {
				for (let c = 0; c < readable; c++)
					out[i * components + c] = reader(view, base + c * componentSize);
			}
		}
		return out;
	}

	/* The textures a draw call samples, by slot. Render-target textures among them also record which framebuffer
	 * feeds the one being drawn to. */
	boundTextures(program, info, target) {
		if (!info.samplers.length)
			return [];
		const g = this.g;
		const previousUnit = g.getParameter(GL.ACTIVE_TEXTURE);
		const found = [];
		try {
			for (const sampler of info.samplers) {
				const unit = this.uniformValue(program, sampler.name, 0, sampler.location, true);
				if (!(unit >= 0 && unit < this.maxTextureUnits))
					continue;
				g.activeTexture(GL.TEXTURE0 + unit);
				const texture = g.getParameter(GL.TEXTURE_BINDING_2D);
				if (!texture)
					continue;
				const source = renderTargetTextures.get(texture);
				if (source)
					this.session.feed(idOf(source), target);
				if (sampler.slot !== 'exclude')
					found.push({ texture, uniform: sampler.name, slot: sampler.slot, priority: sampler.priority });
			}
		} finally {
			g.activeTexture(previousUnit);
		}
		return assignTextureSlots(found);
	}

	/* ---- the per draw call capture ---- */

	captureDraw(mode, first, count, indexType, indexOffset) {
		const s = this.session;
		const g = this.g;
		if (!MODE_NAMES[mode]) {
			s.stats.unsupportedMode++;
			return;
		}
		if (!(count > 0))
			return;
		const program = g.getParameter(GL.CURRENT_PROGRAM);
		if (!program)
			return;
		const target = idOf(g.getParameter(GL.FRAMEBUFFER_BINDING)); // 0 = the canvas
		const viewport = Array.from(g.getParameter(GL.VIEWPORT));
		const drawn = s.targets.get(target);
		if (drawn) {
			drawn.draws++;
			drawn.last = s.drawCount;
		} else {
			s.targets.set(target, { draws: 1, last: s.drawCount });
		}
		const info = this.programInfo(program);
		// read before the position check: full-screen passes without attributes still link render targets
		const textures = this.boundTextures(program, info, target);
		const position = info.attribs.position && this.attribState(info.attribs.position.location);
		if (!position) {
			s.stats.noPosition++;
			if (!info.attribs.position && info.attributeNames.length)
				s.unrecognizedAttributes.add(info.attributeNames.join(', '));
			return;
		}

		let indexBuffer = null;
		if (indexType >= 0) {
			indexBuffer = g.getParameter(GL.ELEMENT_ARRAY_BUFFER_BINDING);
			if (!indexBuffer)
				return;
		}

		const normal = info.attribs.normal ? this.attribState(info.attribs.normal.location) : null;
		const uv = info.attribs.uv ? this.attribState(info.attribs.uv.location) : null;
		const color = s.settings.vertexColors && info.attribs.color ? this.attribState(info.attribs.color.location) : null;
		const matrix = s.settings.applyMatrix ? this.drawMatrix(program, info) : null;
		const score = textures.length * 4 + (uv ? 2 : 0) + (normal ? 1 : 0) + (color ? 1 : 0);

		const geometryKey = [this.index, mode, idOf(position.buffer), position.offset, position.stride, position.type,
			position.size, indexBuffer ? `e${idOf(indexBuffer)}:${indexType}:${indexOffset}:${count}` : `a${first}:${count}`].join('|');
		const exactKey = matrix && matrix.m ? `${geometryKey}|${matrix.kind}|${Array.prototype.join.call(matrix.m, ',')}` : geometryKey;
		let replaces = null;
		if (s.settings.skipDuplicates) {
			const existing = s.exactKeys.get(exactKey);
			if (existing) {
				if (score <= existing.score) {
					s.stats.duplicates++;
					return existing;
				}
				replaces = existing;
			}
		}

		let indices;
		let restart = -1;
		if (indexBuffer) {
			indices = this.readIndices(indexBuffer, indexType, indexOffset, count);
			if (!indices) {
				s.stats.unreadable++;
				return;
			}
			if (this.webgl2)
				restart = PRIMITIVE_RESTART[indexType]; // always enabled in WebGL 2
		} else {
			indices = new Uint32Array(count);
			for (let i = 0; i < count; i++)
				indices[i] = first + i;
		}

		const triangles = triangulate(mode, indices, restart);
		if (!triangles.length)
			return;
		const { remapped, unique, min, max } = compactVertices(triangles);
		const positions = this.readAttribute(position, unique, min, max, 3);
		if (!positions) {
			s.stats.unreadable++;
			return;
		}

		const mesh = {
			context: this,
			draw: s.drawCount,
			mode,
			score,
			target,
			viewport,
			geometryKey,
			matrix,
			textures,
			color: this.readColor(program, info.colors.base),
			emissive: this.readColor(program, info.colors.emissive),
			blend: g.isEnabled(GL.BLEND),
			doubleSided: !g.isEnabled(GL.CULL_FACE),
			vertexCount: unique.length,
			triangles: remapped,
			positions,
			normals: normal ? this.readAttribute(normal, unique, min, max, 3) : null,
			uvs: uv ? this.readAttribute(uv, unique, min, max, 2) : null,
			colors: color ? this.readAttribute(color, unique, min, max, 3) : null,
			program: {
				position: info.attribs.position.name,
				normal: normal ? info.attribs.normal.name : null,
				uv: uv ? info.attribs.uv.name : null,
				color: color ? info.attribs.color.name : null,
				matrix: info.model ? info.model.name : info.modelView ? info.modelView.name : null
			}
		};
		if (replaces)
			s.meshes[s.meshes.indexOf(replaces)] = mesh;
		else
			s.meshes.push(mesh);
		s.exactKeys.set(exactKey, mesh);
		return mesh;
	}

	/* ---- pick mode: the last draw that changed the pixel under the cursor drew the visible surface there ---- */

	probe(mesh) {
		const g = this.g;
		const pick = this.session.pick;
		const framebuffer = g.getParameter(GL.FRAMEBUFFER_BINDING);
		const target = idOf(framebuffer);
		if (this.unreadableTargets.has(target))
			return;
		let x, y;
		if (framebuffer) {
			// render targets usually cover the whole canvas at some resolution
			const viewport = g.getParameter(GL.VIEWPORT);
			x = viewport[0] + pick.x * viewport[2];
			y = viewport[1] + pick.y * viewport[3];
		} else {
			x = pick.x * this.gl.drawingBufferWidth;
			y = pick.y * this.gl.drawingBufferHeight;
		}
		const color = this.readPixel(framebuffer, target, Math.floor(x), Math.floor(y));
		if (color === null) {
			this.unreadableTargets.add(target);
			return;
		}
		const previous = this.pickPixels.get(target);
		this.pickPixels.set(target, color);
		if (mesh && previous !== undefined && previous !== color)
			mesh.pickHit = this.session.drawCount;
	}

	readPixel(framebuffer, target, x, y) {
		const g = this.g;
		const readBinding = this.webgl2 ? g.getParameter(GL.READ_FRAMEBUFFER_BINDING) : null;
		const pack = this.savePackState();
		try {
			if (this.webgl2)
				g.bindFramebuffer(GL.READ_FRAMEBUFFER, framebuffer);
			let type = this.readTypes.get(target);
			if (type === undefined) {
				const status = g.checkFramebufferStatus(this.webgl2 ? GL.READ_FRAMEBUFFER : GL.FRAMEBUFFER);
				const multisampled = framebuffer && this.webgl2 && g.getParameter(GL.SAMPLES) > 0;
				const readType = g.getParameter(GL.IMPLEMENTATION_COLOR_READ_TYPE);
				const float = FLOAT_TEXEL_TYPES.has(readType) && this.webgl2;
				if (float)
					g.getExtension('EXT_color_buffer_float'); // reading float targets as RGBA/FLOAT needs it
				type = status !== GL.FRAMEBUFFER_COMPLETE || multisampled ? 0 : float ? GL.FLOAT : GL.UNSIGNED_BYTE;
				this.readTypes.set(target, type);
			}
			if (!type)
				return null;
			const pixel = type === GL.FLOAT ? new Float32Array(4) : new Uint8Array(4);
			g.readPixels(x, y, 1, 1, GL.RGBA, type, pixel);
			return Array.prototype.join.call(pixel, ',');
		} finally {
			if (this.webgl2)
				g.bindFramebuffer(GL.READ_FRAMEBUFFER, readBinding);
			this.restorePackState(pack);
		}
	}

	/* ---- texture readback (runs after the frame, with full GL state save/restore) ---- */

	/* Prepares a texture for reading in horizontal bands, so not even an 8K texture needs one big buffer.
	 * Returns { width, height, readRows(y, rows), close() }, or null when the texture can't be read. */
	openTexture(texture) {
		const g = this.g;
		if (g.isContextLost() || !g.isTexture(texture))
			return null;
		const info = textureInfo.get(texture);
		if (info && (isIntegerFormat(info.internalFormat) || DEPTH_FORMATS.has(info.internalFormat)))
			return null;
		const settings = this.session.settings;
		const maxSize = g.getParameter(GL.MAX_TEXTURE_SIZE) || 4096;
		let width = info ? info.width | 0 : 0;
		let height = info ? info.height | 0 : 0;
		if (!(width > 0 && height > 0)) {
			width = settings.fallbackWidth;
			height = settings.fallbackHeight;
		}
		width = Math.min(width, maxSize);
		height = Math.min(height, maxSize);

		// Formats that can't be read directly are drawn into an RGBA8 copy first. Textures of unknown format go that
		// way as well: when the size had to be guessed, a drawn copy is scaled instead of cropped.
		const needsCopy = !info || info.compressed || FLOAT_TEXEL_TYPES.has(info.type) ||
			FLOAT_FORMATS.has(info.internalFormat) || UNRENDERABLE_FORMATS.has(info.internalFormat);
		let source = !needsCopy && this.canAttach(texture) ? texture : null;
		if (!source)
			source = this.drawCopy(texture, width, height, !!info && SRGB_FORMATS.has(info.internalFormat));
		if (!source && needsCopy && this.canAttach(texture))
			source = texture;
		if (!source)
			return null;
		return {
			width,
			height,
			readRows: (y, rows) => this.readRows(source, width, y, rows),
			close: () => {
				if (source !== texture && !g.isContextLost())
					g.deleteTexture(source);
			}
		};
	}

	savePackState() {
		const g = this.g;
		const state = { alignment: g.getParameter(GL.PACK_ALIGNMENT) };
		g.pixelStorei(GL.PACK_ALIGNMENT, 4);
		if (this.webgl2) {
			state.rowLength = g.getParameter(GL.PACK_ROW_LENGTH);
			state.skipRows = g.getParameter(GL.PACK_SKIP_ROWS);
			state.skipPixels = g.getParameter(GL.PACK_SKIP_PIXELS);
			state.buffer = g.getParameter(GL.PIXEL_PACK_BUFFER_BINDING);
			g.pixelStorei(GL.PACK_ROW_LENGTH, 0);
			g.pixelStorei(GL.PACK_SKIP_ROWS, 0);
			g.pixelStorei(GL.PACK_SKIP_PIXELS, 0);
			g.bindBuffer(GL.PIXEL_PACK_BUFFER, null);
		}
		return state;
	}

	restorePackState(state) {
		const g = this.g;
		g.pixelStorei(GL.PACK_ALIGNMENT, state.alignment);
		if (this.webgl2) {
			g.pixelStorei(GL.PACK_ROW_LENGTH, state.rowLength);
			g.pixelStorei(GL.PACK_SKIP_ROWS, state.skipRows);
			g.pixelStorei(GL.PACK_SKIP_PIXELS, state.skipPixels);
			g.bindBuffer(GL.PIXEL_PACK_BUFFER, state.buffer);
		}
	}

	resources() {
		if (!this.reader) {
			this.reader = { framebuffer: this.g.createFramebuffer(), blit: undefined };
			ownFramebuffers.add(this.reader.framebuffer);
		}
		return this.reader;
	}

	/* Whether the texture can be attached to a framebuffer and read directly (every color-renderable format). */
	canAttach(texture) {
		const g = this.g;
		const target = this.webgl2 ? GL.READ_FRAMEBUFFER : GL.FRAMEBUFFER;
		const previous = g.getParameter(this.webgl2 ? GL.READ_FRAMEBUFFER_BINDING : GL.FRAMEBUFFER_BINDING);
		try {
			g.bindFramebuffer(target, this.resources().framebuffer);
			g.framebufferTexture2D(target, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
			return g.checkFramebufferStatus(target) === GL.FRAMEBUFFER_COMPLETE;
		} finally {
			g.framebufferTexture2D(target, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, null, 0);
			g.bindFramebuffer(target, previous);
		}
	}

	/* Reads GL rows [y, y + rows) of a color-renderable texture. The page keeps rendering between calls, so the
	 * framebuffer and pixel-store state is saved and restored every time. */
	readRows(texture, width, y, rows) {
		const g = this.g;
		if (g.isContextLost())
			return null;
		const target = this.webgl2 ? GL.READ_FRAMEBUFFER : GL.FRAMEBUFFER;
		const previous = g.getParameter(this.webgl2 ? GL.READ_FRAMEBUFFER_BINDING : GL.FRAMEBUFFER_BINDING);
		const pack = this.savePackState();
		try {
			g.bindFramebuffer(target, this.resources().framebuffer);
			g.framebufferTexture2D(target, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
			if (g.checkFramebufferStatus(target) !== GL.FRAMEBUFFER_COMPLETE)
				return null;
			const pixels = new Uint8Array(width * rows * 4);
			g.readPixels(0, y, width, rows, GL.RGBA, GL.UNSIGNED_BYTE, pixels);
			return pixels;
		} finally {
			g.framebufferTexture2D(target, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, null, 0);
			g.bindFramebuffer(target, previous);
			this.restorePackState(pack);
		}
	}

	/* Slow path for compressed, float and luminance textures: draw the texture into an RGBA8 target. */
	blitResources() {
		const reader = this.resources();
		if (reader.blit !== undefined)
			return reader.blit;
		reader.blit = null;
		const g = this.g;
		const vertexSource = this.webgl2
			? '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID&1)<<2)-1.0,float((gl_VertexID&2)<<1)-1.0);gl_Position=vec4(p,0.0,1.0);}'
			: 'attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0.0,1.0);}';
		const encode = 'vec3 enc(vec3 c){c=clamp(c,0.0,1.0);return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));}';
		const fragmentSource = this.webgl2
			? `#version 300 es\nprecision highp float;uniform highp sampler2D u_src;uniform vec2 u_size;uniform float u_srgb;out vec4 o;${encode}void main(){vec4 c=texture(u_src,gl_FragCoord.xy/u_size);o=u_srgb>0.5?vec4(enc(c.rgb),c.a):c;}`
			: `#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\nuniform sampler2D u_src;uniform vec2 u_size;uniform float u_srgb;${encode}void main(){vec4 c=texture2D(u_src,gl_FragCoord.xy/u_size);gl_FragColor=u_srgb>0.5?vec4(enc(c.rgb),c.a):c;}`;

		const vaoExtension = this.webgl2 ? null : this.vertexArrayExtension();
		if (!this.webgl2 && !vaoExtension)
			return null;
		const compile = (type, source) => {
			const shader = g.createShader(type);
			g.shaderSource(shader, source);
			g.compileShader(shader);
			return shader;
		};
		const vertexShader = compile(GL.VERTEX_SHADER, vertexSource);
		const fragmentShader = compile(GL.FRAGMENT_SHADER, fragmentSource);
		const program = g.createProgram();
		g.attachShader(program, vertexShader);
		g.attachShader(program, fragmentShader);
		if (!this.webgl2)
			g.bindAttribLocation(program, 0, 'a_pos');
		g.linkProgram(program);
		g.deleteShader(vertexShader);
		g.deleteShader(fragmentShader);
		if (!g.getProgramParameter(program, GL.LINK_STATUS)) {
			log('Could not build the texture copy shader:', g.getProgramInfoLog(program));
			g.deleteProgram(program);
			return null;
		}
		const blit = {
			program,
			source: g.getUniformLocation(program, 'u_src'),
			size: g.getUniformLocation(program, 'u_size'),
			srgb: g.getUniformLocation(program, 'u_srgb'),
			vaoExtension,
			vao: null,
			vertexBuffer: null,
			sampler: null
		};
		if (this.webgl2) {
			blit.sampler = g.createSampler();
			g.samplerParameteri(blit.sampler, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
			g.samplerParameteri(blit.sampler, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
			g.samplerParameteri(blit.sampler, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
			g.samplerParameteri(blit.sampler, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
		} else {
			// Called with the page's VAO and ARRAY_BUFFER saved by saveDrawState()
			blit.vao = vaoExtension.createVertexArrayOES();
			vaoExtension.bindVertexArrayOES(blit.vao);
			blit.vertexBuffer = g.createBuffer();
			g.bindBuffer(GL.ARRAY_BUFFER, blit.vertexBuffer);
			g.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), GL.STATIC_DRAW);
			g.enableVertexAttribArray(0);
			g.vertexAttribPointer(0, 2, GL.FLOAT, false, 0, 0);
		}
		reader.blit = blit;
		return blit;
	}

	saveDrawState() {
		const g = this.g;
		const state = {
			drawFramebuffer: g.getParameter(GL.FRAMEBUFFER_BINDING),
			readFramebuffer: this.webgl2 ? g.getParameter(GL.READ_FRAMEBUFFER_BINDING) : null,
			viewport: g.getParameter(GL.VIEWPORT),
			colorMask: g.getParameter(GL.COLOR_WRITEMASK),
			program: g.getParameter(GL.CURRENT_PROGRAM),
			activeTexture: g.getParameter(GL.ACTIVE_TEXTURE),
			arrayBuffer: g.getParameter(GL.ARRAY_BUFFER_BINDING),
			capabilities: DRAW_CAPABILITIES
				.filter(cap => this.webgl2 || cap !== GL.RASTERIZER_DISCARD)
				.map(cap => [cap, g.isEnabled(cap)])
		};
		g.activeTexture(GL.TEXTURE0);
		state.texture0 = g.getParameter(GL.TEXTURE_BINDING_2D);
		if (this.webgl2)
			state.sampler0 = g.getParameter(GL.SAMPLER_BINDING);
		else if (this.vertexArrayExtension())
			state.vertexArray = g.getParameter(GL.VERTEX_ARRAY_BINDING);
		for (const [cap] of state.capabilities)
			g.disable(cap);
		g.colorMask(true, true, true, true);
		return state;
	}

	restoreDrawState(state) {
		const g = this.g;
		if (this.webgl2) {
			g.bindFramebuffer(GL.DRAW_FRAMEBUFFER, state.drawFramebuffer);
			g.bindFramebuffer(GL.READ_FRAMEBUFFER, state.readFramebuffer);
			g.bindSampler(0, state.sampler0);
		} else {
			g.bindFramebuffer(GL.FRAMEBUFFER, state.drawFramebuffer);
			if (this.vaoExtension)
				this.vaoExtension.bindVertexArrayOES(state.vertexArray || null);
		}
		g.bindTexture(GL.TEXTURE_2D, state.texture0);
		g.activeTexture(state.activeTexture);
		g.useProgram(state.program);
		g.bindBuffer(GL.ARRAY_BUFFER, state.arrayBuffer);
		g.viewport(state.viewport[0], state.viewport[1], state.viewport[2], state.viewport[3]);
		g.colorMask(state.colorMask[0], state.colorMask[1], state.colorMask[2], state.colorMask[3]);
		for (const [cap, enabled] of state.capabilities) {
			if (enabled)
				g.enable(cap);
		}
	}

	/* Draws the texture into a new RGBA8 texture of the given size and returns it (the caller deletes it). */
	drawCopy(texture, width, height, srgb) {
		const g = this.g;
		const state = this.saveDrawState();
		let blit = null;
		let target = null;
		let keep = false;
		let savedParams = null;
		try {
			blit = this.blitResources();
			if (!blit)
				return null;
			target = g.createTexture();
			g.bindTexture(GL.TEXTURE_2D, target);
			if (this.webgl2)
				g.texStorage2D(GL.TEXTURE_2D, 1, GL.RGBA8, width, height);
			else
				g.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, width, height, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
			g.bindFramebuffer(GL.FRAMEBUFFER, this.resources().framebuffer);
			g.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, target, 0);
			if (g.checkFramebufferStatus(GL.FRAMEBUFFER) !== GL.FRAMEBUFFER_COMPLETE)
				return null;

			g.bindTexture(GL.TEXTURE_2D, texture);
			if (this.webgl2) {
				g.bindSampler(0, blit.sampler);
			} else {
				// WebGL 1 has no sampler objects: switch to NEAREST/CLAMP (needed for NPOT textures) and put it back after
				const params = [GL.TEXTURE_MIN_FILTER, GL.TEXTURE_MAG_FILTER, GL.TEXTURE_WRAP_S, GL.TEXTURE_WRAP_T];
				savedParams = params.map(p => [p, g.getTexParameter(GL.TEXTURE_2D, p)]);
				g.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
				g.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
				g.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
				g.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
				blit.vaoExtension.bindVertexArrayOES(blit.vao);
			}
			g.useProgram(blit.program);
			g.uniform1i(blit.source, 0);
			g.uniform2f(blit.size, width, height);
			g.uniform1f(blit.srgb, srgb ? 1 : 0);
			g.viewport(0, 0, width, height);
			g.drawArrays(GL.TRIANGLES, 0, 3);
			keep = true;
			return target;
		} finally {
			if (savedParams) {
				g.bindTexture(GL.TEXTURE_2D, texture);
				for (const [param, value] of savedParams) {
					if (value !== null)
						g.texParameteri(GL.TEXTURE_2D, param, value);
				}
			}
			if (target)
				g.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, null, 0);
			this.restoreDrawState(state);
			if (target && !keep)
				g.deleteTexture(target);
		}
	}

	disposeReader() {
		const reader = this.reader;
		this.reader = null;
		if (!reader || this.g.isContextLost())
			return;
		const g = this.g;
		g.deleteFramebuffer(reader.framebuffer);
		const blit = reader.blit;
		if (blit) {
			g.deleteProgram(blit.program);
			if (blit.sampler) g.deleteSampler(blit.sampler);
			if (blit.vertexBuffer) g.deleteBuffer(blit.vertexBuffer);
			if (blit.vao) blit.vaoExtension.deleteVertexArrayOES(blit.vao);
		}
	}
}

/* ------------------------------------------------------------------------------------------------------------
 * Encoders: CRC32, PNG and ZIP. Built on CompressionStream so no third party library is needed, and PNGs are
 * written byte-exact (canvas.toDataURL premultiplies alpha and destroys color in transparent texels).
 * ---------------------------------------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++)
			c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

// Slicing-by-16: table k holds the CRC of a byte followed by k zero bytes, so 16 bytes are folded in at once
const CRC_TABLES = (() => {
	const tables = new Int32Array(256 * 16);
	tables.set(CRC_TABLE);
	for (let n = 0; n < 256; n++) {
		let c = CRC_TABLE[n];
		for (let k = 1; k < 16; k++) {
			c = CRC_TABLE[c & 0xFF] ^ (c >>> 8);
			tables[k * 256 + n] = c;
		}
	}
	return tables;
})();

function crc32Update(crc, bytes) {
	const T = CRC_TABLES;
	const length = bytes.length;
	let i = 0;
	for (const end = length - 15; i < end; i += 16) {
		const a = crc ^ (bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16 | bytes[i + 3] << 24);
		crc = T[3840 + (a & 0xFF)] ^ T[3584 + ((a >>> 8) & 0xFF)] ^ T[3328 + ((a >>> 16) & 0xFF)] ^ T[3072 + (a >>> 24)] ^
			T[2816 + bytes[i + 4]] ^ T[2560 + bytes[i + 5]] ^ T[2304 + bytes[i + 6]] ^ T[2048 + bytes[i + 7]] ^
			T[1792 + bytes[i + 8]] ^ T[1536 + bytes[i + 9]] ^ T[1280 + bytes[i + 10]] ^ T[1024 + bytes[i + 11]] ^
			T[768 + bytes[i + 12]] ^ T[512 + bytes[i + 13]] ^ T[256 + bytes[i + 14]] ^ T[bytes[i + 15]];
	}
	for (; i < length; i++)
		crc = T[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
	return crc;
}

function crc32(chunks) {
	let crc = -1;
	for (const chunk of chunks)
		crc = crc32Update(crc, chunk);
	return (crc ^ -1) >>> 0;
}

const BLOB_SPILL_SIZE = 8 * 1024 * 1024;

/* Collects bytes and moves them into Blobs every few MB, so large exports live in the browser's blob storage
 * (which can page to disk) instead of the page's memory. */
class BlobCollector {
	constructor() {
		this.blobs = [];
		this.pending = [];
		this.pendingSize = 0;
		this.size = 0;
	}

	push(bytes) {
		if (!bytes.length)
			return;
		this.pending.push(bytes);
		this.pendingSize += bytes.length;
		this.size += bytes.length;
		if (this.pendingSize >= BLOB_SPILL_SIZE)
			this.spill();
	}

	/* Adds a Blob, or everything another collector holds, after what is here. Small pieces stay plain bytes until
	 * the next spill: making a Blob costs a round trip to the browser process, too much for every little file. */
	append(source) {
		const blobs = source instanceof native.Blob ? [source] : source.blobs;
		for (const blob of blobs) {
			if (!blob.size)
				continue;
			this.spill();
			this.blobs.push(blob);
			this.size += blob.size;
		}
		if (!(source instanceof native.Blob)) {
			for (const bytes of source.pending)
				this.push(bytes);
		}
	}

	spill() {
		if (this.pending.length) {
			this.blobs.push(new native.Blob(this.pending));
			this.pending = [];
			this.pendingSize = 0;
		}
	}

	toBlob(type) {
		this.spill();
		return new native.Blob(this.blobs, type ? { type } : undefined);
	}
}

async function drainInto(readable, collector) {
	const reader = readable.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done)
			return;
		collector.push(value);
	}
}

let deflateRawSupport = null;
function supportsDeflateRaw() {
	if (deflateRawSupport === null) {
		try {
			new native.CompressionStream('deflate-raw');
			deflateRawSupport = true;
		} catch (err) {
			deflateRawSupport = false;
		}
	}
	return deflateRawSupport;
}

function concatBytes(parts) {
	const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function pngChunk(type, data) {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++)
		out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32([out.subarray(4, 8 + data.length)]));
	return out;
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
const IDAT_CHUNK_SIZE = 1024 * 1024;
const PIXEL_BAND_SIZE = 4 * 1024 * 1024;

/* Writes a PNG through `write`, which receives the file in consecutive byte chunks. readRows(y, rows) returns GL rows
 * (bottom-up RGBA, as readPixels does); with flipRows the first PNG row is the last GL row, which is what OBJ texture
 * coordinates expect (v = 0 at the bottom of the image). The image is read, filtered, compressed and emitted in
 * bands of a few MB, so memory use doesn't depend on the texture size. */
async function encodePNG(width, height, readRows, flipRows, write) {
	const bandRows = Math.max(1, Math.floor(PIXEL_BAND_SIZE / (width * 4)));
	let cached = null;
	const read = (start, count) => {
		if (cached && cached.start === start && cached.count === count)
			return cached.data;
		const data = readRows(start, count);
		if (!data)
			throw new RipperError('The texture could not be read.');
		cached = { start, count, data };
		return data;
	};

	// Opaque images are stored as RGB. The check stops at the first band with a transparent texel.
	let opaque = true;
	for (let start = 0; start < height && opaque; start += bandRows) {
		const band = read(start, Math.min(bandRows, height - start));
		for (let i = 3; i < band.length; i += 4) {
			if (band[i] !== 255) {
				opaque = false;
				break;
			}
		}
		await breathe();
	}
	const glRow = (y) => {
		const start = flipRows ? Math.max(0, y - bandRows + 1) : y - (y % bandRows);
		const count = flipRows ? y - start + 1 : Math.min(bandRows, height - start);
		const band = cached && y >= cached.start && y < cached.start + cached.count ? cached : { start, data: read(start, count) };
		const offset = (y - band.start) * width * 4;
		return band.data.subarray(offset, offset + width * 4);
	};

	const channels = opaque ? 3 : 4;
	const rowLength = width * channels;

	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8;                  // bit depth
	header[9] = opaque ? 2 : 6;     // RGB / RGBA
	await write(PNG_SIGNATURE);
	await write(pngChunk('IHDR', header));

	const stream = new native.CompressionStream('deflate');
	const writer = stream.writable.getWriter();
	const emitting = (async () => {
		const reader = stream.readable.getReader();
		try {
			let pending = [], pendingSize = 0;
			for (;;) {
				const { value, done } = await reader.read();
				if (value) {
					pending.push(value);
					pendingSize += value.length;
				}
				if (pendingSize && (done || pendingSize >= IDAT_CHUNK_SIZE)) {
					await write(pngChunk('IDAT', pending.length === 1 ? pending[0] : concatBytes(pending)));
					pending = [];
					pendingSize = 0;
				}
				if (done)
					return;
			}
		} catch (err) {
			reader.cancel(err).catch(() => {}); // unblocks the writer below
			throw err;
		}
	})();

	// Every row uses the "Up" filter (the difference to the row above). Measured on real 4K textures it compresses as
	// well as Paeth or better, and deflate, which takes most of the time, gets through it about a third faster.
	let previous = new Uint8Array(rowLength);
	let packed = opaque ? new Uint8Array(rowLength) : null; // the RGB row, for the next row's filter
	const rowsPerChunk = Math.max(1, Math.floor((1 << 20) / (rowLength + 1)));
	try {
		for (let y0 = 0; y0 < height; y0 += rowsPerChunk) {
			const rows = Math.min(rowsPerChunk, height - y0);
			const chunk = new Uint8Array(rows * (rowLength + 1));
			for (let r = 0; r < rows; r++) {
				const source = glRow(flipRows ? height - 1 - (y0 + r) : y0 + r);
				const out = r * (rowLength + 1) + 1;
				chunk[out - 1] = 2;
				if (opaque) {
					for (let s = 0, o = 0; o < rowLength; s += 4, o += 3) {
						const red = source[s], green = source[s + 1], blue = source[s + 2];
						chunk[out + o] = red - previous[o];
						chunk[out + o + 1] = green - previous[o + 1];
						chunk[out + o + 2] = blue - previous[o + 2];
						packed[o] = red;
						packed[o + 1] = green;
						packed[o + 2] = blue;
					}
					const swap = previous;
					previous = packed;
					packed = swap;
				} else {
					for (let i = 0; i < rowLength; i++)
						chunk[out + i] = source[i] - previous[i];
					previous = source; // a view of its band, which stays alive while referenced
				}
			}
			await writer.write(chunk);
			await breathe();
		}
		await writer.close();
	} catch (err) {
		writer.abort(err).catch(() => {});
		emitting.catch(() => {});
		throw err;
	}
	await emitting;
	await write(pngChunk('IEND', new Uint8Array(0)));
	return { opaque };
}

/* ZIP archive whose files are streamed in: each file is compressed while it is written and its data is kept as a
 * Blob, so only small pieces of the export are in the page's memory at any time. */
class ZipBuilder {
	constructor(date = new Date()) {
		this.archive = new BlobCollector();
		this.entries = [];
		this.offset = 0;
		this.time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
		this.date = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
		this.encoder = new native.TextEncoder();
	}

	get count() {
		return this.entries.length;
	}

	/* Starts a file and returns { write(bytes), close() }. Files appear in the archive in the order they are closed. */
	open(name, compress) {
		const nameBytes = this.encoder.encode(name);
		const data = new BlobCollector();
		const deflate = !!compress && supportsDeflateRaw();
		let crc = -1, size = 0, writer = null, draining = null;
		if (deflate) {
			const stream = new native.CompressionStream('deflate-raw');
			writer = stream.writable.getWriter();
			draining = drainInto(stream.readable, data);
		}
		return {
			write: async (bytes) => {
				if (!bytes.length)
					return;
				crc = crc32Update(crc, bytes);
				size += bytes.length;
				if (writer)
					await writer.write(bytes);
				else
					data.push(bytes);
			},
			close: async () => {
				if (writer) {
					await writer.close();
					await draining;
				}
				this.append(nameBytes, (crc ^ -1) >>> 0, deflate ? 8 : 0, data, data.size, size);
			}
		};
	}

	/* Adds data that is already a Blob with a known CRC (PNGs are encoded once and shared by every output). */
	addStored(name, blob, crc) {
		this.append(this.encoder.encode(name), crc, 0, blob, blob.size, blob.size);
	}

	/* data is a Blob or a BlobCollector, storedSize its length in the archive, size the length of the file. */
	append(nameBytes, crc, method, data, storedSize, size) {
		if (this.entries.length >= 0xFFFF || size > 0xFFFFFFFF || this.offset + 30 + nameBytes.length + storedSize > 0xFFFFFFFF)
			throw new RipperError('The capture is too large for a .zip file (4 GB / 65535 files). Disable "Download as ZIP".');
		const header = new Uint8Array(30 + nameBytes.length);
		const v = new DataView(header.buffer);
		v.setUint32(0, 0x04034B50, true);
		v.setUint16(4, 20, true);
		v.setUint16(6, 0x0800, true);   // UTF-8 names
		v.setUint16(8, method, true);
		v.setUint16(10, this.time, true);
		v.setUint16(12, this.date, true);
		v.setUint32(14, crc, true);
		v.setUint32(18, storedSize, true);
		v.setUint32(22, size, true);
		v.setUint16(26, nameBytes.length, true);
		header.set(nameBytes, 30);
		this.archive.push(header);
		this.archive.append(data);
		this.entries.push({ nameBytes, crc, method, storedSize, size, offset: this.offset });
		this.offset += header.length + storedSize;
	}

	toBlob() {
		let directorySize = 0;
		for (const e of this.entries) {
			const record = new Uint8Array(46 + e.nameBytes.length);
			const v = new DataView(record.buffer);
			v.setUint32(0, 0x02014B50, true);
			v.setUint16(4, 20, true);
			v.setUint16(6, 20, true);
			v.setUint16(8, 0x0800, true);
			v.setUint16(10, e.method, true);
			v.setUint16(12, this.time, true);
			v.setUint16(14, this.date, true);
			v.setUint32(16, e.crc, true);
			v.setUint32(20, e.storedSize, true);
			v.setUint32(24, e.size, true);
			v.setUint16(28, e.nameBytes.length, true);
			v.setUint32(42, e.offset, true);
			record.set(e.nameBytes, 46);
			this.archive.push(record);
			directorySize += record.length;
		}
		const end = new Uint8Array(22);
		const v = new DataView(end.buffer);
		v.setUint32(0, 0x06054B50, true);
		v.setUint16(8, this.entries.length, true);
		v.setUint16(10, this.entries.length, true);
		v.setUint32(12, directorySize, true);
		v.setUint32(16, this.offset, true);
		this.archive.push(end);
		return this.archive.toBlob('application/zip');
	}
}

/* The same interface as ZipBuilder, but every file becomes its own download. */
class DownloadOutput {
	constructor() {
		this.count = 0;
	}

	async addStored(name, blob) {
		saveBlob(name, blob);
		this.count++;
		await sleep(250);
	}

	open(name) {
		const data = new BlobCollector();
		return {
			write: async (bytes) => data.push(bytes),
			close: async () => {
				saveBlob(name, data.toBlob(name.endsWith('.png') ? 'image/png' : 'text/plain'));
				this.count++;
				await sleep(250); // give the browser time to start each download
			}
		};
	}
}

/* ------------------------------------------------------------------------------------------------------------
 * Export: meshes -> OBJ/MTL, textures -> PNG, everything -> .zip or separate downloads.
 * ---------------------------------------------------------------------------------------------------------- */

function formatNumber(value) {
	if (!Number.isFinite(value))
		return '0';
	const rounded = Math.round(value * 1e6) / 1e6;
	return rounded === 0 ? '0' : String(rounded);
}

function finalizeMeshes(session) {
	let meshes = session.meshes.slice();
	if (session.settings.skipOverlays) {
		// Viewer chrome goes first, so a gizmo drawing the same geometry can't win over the model below: gizmos and
		// minimaps use a small viewport of the same target, and post-processing passes are a full-screen triangle or
		// quad that samples textures the page rendered itself.
		const area = (m) => Math.max(0, m.viewport[2]) * Math.max(0, m.viewport[3]);
		const largest = new Map();
		for (const mesh of meshes) {
			const key = `${mesh.context.index}:${mesh.target}`;
			largest.set(key, Math.max(largest.get(key) || 0, area(mesh)));
		}
		meshes = meshes.filter(mesh => {
			const overlay = area(mesh) < 0.25 * largest.get(`${mesh.context.index}:${mesh.target}`);
			const screenPass = mesh.vertexCount <= 4 && mesh.textures.length > 0 &&
				mesh.textures.every(t => renderTargetTextures.has(t.texture));
			if (overlay || screenPass)
				session.stats.overlays++;
			return !overlay && !screenPass;
		});
	}

	const closer = targetOrder(session);
	if (session.settings.skipDuplicates) {
		// Shadow maps, reflections and depth pre-passes draw the same geometry again. When that happened, keep
		// the draws that went to the target closest to the screen ...
		const groups = new Map();
		for (const mesh of meshes) {
			const group = groups.get(mesh.geometryKey);
			if (group) group.push(mesh);
			else groups.set(mesh.geometryKey, [mesh]);
		}
		const preferredTarget = new Map();
		for (const [key, group] of groups) {
			const targets = new Set(group.map(m => m.target));
			if (targets.size < 2)
				continue;
			let best = null;
			for (const t of targets) {
				if (best === null || closer(t, best) > 0)
					best = t;
			}
			preferredTarget.set(key, best);
		}
		// ... and drop untextured copies when a richer version of the same geometry exists.
		const bestScore = new Map();
		for (const mesh of meshes) {
			if (!preferredTarget.has(mesh.geometryKey) || preferredTarget.get(mesh.geometryKey) === mesh.target)
				bestScore.set(mesh.geometryKey, Math.max(bestScore.get(mesh.geometryKey) || 0, mesh.score));
		}
		meshes = meshes.filter(mesh => {
			const drop = (preferredTarget.has(mesh.geometryKey) && preferredTarget.get(mesh.geometryKey) !== mesh.target) ||
				(mesh.textures.length === 0 && mesh.score < bestScore.get(mesh.geometryKey));
			if (drop)
				session.stats.duplicates++;
			return !drop;
		});
	}
	// The camera of a context is the one most of its remaining draws used
	const cameras = new Map();
	for (const mesh of meshes) {
		const view = mesh.matrix && mesh.matrix.view;
		if (!view)
			continue;
		let counts = cameras.get(mesh.context);
		if (!counts)
			cameras.set(mesh.context, counts = new Map());
		const key = Array.prototype.join.call(view, ',');
		const entry = counts.get(key);
		if (entry) entry.count++;
		else counts.set(key, { view, count: 1 });
	}
	const cameraOf = (context) => {
		let best = null;
		for (const entry of (cameras.get(context) || new Map()).values()) {
			if (!best || entry.count > best.count)
				best = entry;
		}
		return best ? best.view : null;
	};

	for (const mesh of meshes) {
		mesh.triangleCount = mesh.triangles.length / 3;
		mesh.transform = 'local';
		let m = mesh.matrix && mesh.matrix.m;
		if (m && mesh.matrix.kind === 'modelView') {
			// Without a known camera, camera space would depend on where the user was looking: keep the mesh's
			// own coordinates instead (for single-model viewers that is exactly how the model was authored).
			const view = cameraOf(mesh.context);
			const inverseView = view && invert4(view);
			m = inverseView ? multiply4(inverseView, m) : null;
		}
		if (m) {
			mesh.transform = 'world';
			transformPositions(mesh.positions, m);
			const n = mesh.normals && normalMatrix(m);
			if (n)
				transformNormals(mesh.normals, n);
		}
		if (mesh.colors) {
			let max = 0;
			for (let i = 0; i < mesh.colors.length; i++)
				max = Math.max(max, mesh.colors[i]);
			if (max > 1 && max <= 255) {
				for (let i = 0; i < mesh.colors.length; i++)
					mesh.colors[i] /= 255;
			} else if (max > 255) {
				mesh.colors = null; // not a color after all
			}
			if (mesh.colors && mesh.colors.every(c => c >= 0.999))
				mesh.colors = null; // plain white carries no information
		}
		if (session.settings.weldVertices)
			weldVertices(mesh);
		if (!mesh.normals && session.settings.computeNormals)
			computeNormals(mesh);
	}
	if (session.pick)
		markPickedMesh(meshes, closer);
	return meshes;
}

/* Orders the render targets of a capture by how directly they reach the screen: the canvas, then a target that is
 * sampled (or blitted) into the canvas, like the scene in a post-processing chain, and so on. Shadow maps,
 * reflections and depth pre-passes are further away, since the scene pass samples them, or not linked at all. Ties
 * go to the busier target, then to the one drawn last. Returns a comparator, > 0 when a comes first. */
function targetOrder(session) {
	const hops = new Map([[0, 0]]);
	const queue = [0];
	for (let i = 0; i < queue.length; i++) {
		for (const source of session.feeds.get(queue[i]) || []) {
			if (!hops.has(source)) {
				hops.set(source, hops.get(queue[i]) + 1);
				queue.push(source);
			}
		}
	}
	const none = { draws: 0, last: 0 };
	return (a, b) => {
		const ha = hops.has(a) ? hops.get(a) : Infinity;
		const hb = hops.has(b) ? hops.get(b) : Infinity;
		if (ha !== hb)
			return hb - ha;
		const sa = session.targets.get(a) || none, sb = session.targets.get(b) || none;
		return sa.draws !== sb.draws ? sa.draws - sb.draws : sa.last - sb.last;
	};
}

/* Pick mode: among the meshes that changed the pixel under the cursor, the visible one is drawn last into the
 * render target closest to the screen (shadow maps and the like change other pixels of their own). */
function markPickedMesh(meshes, closer) {
	let picked = null;
	for (const mesh of meshes) {
		if (!mesh.pickHit)
			continue;
		const order = picked ? closer(mesh.target, picked.target) : 1;
		if (order > 0 || (order === 0 && mesh.pickHit > picked.pickHit))
			picked = mesh;
	}
	if (!picked)
		throw new RipperError('Nothing was found under the cursor. Click on a solid part of the object (not its outline).');
	picked.picked = true;
}

/* Smooth normals for meshes the page drew without any: faces are averaged around each position, but only with
 * neighbours less than 60 degrees apart, so hard edges stay hard. */
function computeNormals(mesh, creaseCos = 0.5) {
	const { positions, triangles } = mesh;
	const faces = triangles.length / 3;
	if (!faces)
		return;
	const { remap: position, unique } = dedupeRows([[positions, 3]], mesh.vertexCount);
	const area = new Float64Array(faces * 3);
	const unit = new Float64Array(faces * 3);
	const start = new Uint32Array(unique + 1);
	for (let f = 0; f < faces; f++) {
		const a = triangles[f * 3] * 3, b = triangles[f * 3 + 1] * 3, c = triangles[f * 3 + 2] * 3;
		const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
		const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const length = Math.hypot(nx, ny, nz);
		area[f * 3] = nx;
		area[f * 3 + 1] = ny;
		area[f * 3 + 2] = nz;
		if (length > 0) {
			unit[f * 3] = nx / length;
			unit[f * 3 + 1] = ny / length;
			unit[f * 3 + 2] = nz / length;
		}
		for (let k = 0; k < 3; k++)
			start[position[triangles[f * 3 + k]] + 1]++;
	}
	for (let i = 0; i < unique; i++)
		start[i + 1] += start[i];
	const fill = start.slice(0, unique);
	const incident = new Uint32Array(faces * 3);
	for (let f = 0; f < faces; f++) {
		for (let k = 0; k < 3; k++)
			incident[fill[position[triangles[f * 3 + k]]]++] = f;
	}

	const corners = faces * 3;
	const normals = new Float32Array(corners * 3);
	for (let f = 0; f < faces; f++) {
		for (let k = 0; k < 3; k++) {
			const p = position[triangles[f * 3 + k]];
			let x = 0, y = 0, z = 0;
			for (let i = start[p]; i < start[p + 1]; i++) {
				const g = incident[i];
				if (unit[f * 3] * unit[g * 3] + unit[f * 3 + 1] * unit[g * 3 + 1] + unit[f * 3 + 2] * unit[g * 3 + 2] >= creaseCos) {
					x += area[g * 3];
					y += area[g * 3 + 1];
					z += area[g * 3 + 2];
				}
			}
			let length = Math.hypot(x, y, z);
			if (!(length > 0)) {
				x = unit[f * 3];
				y = unit[f * 3 + 1];
				z = unit[f * 3 + 2];
				length = Math.hypot(x, y, z);
				if (!(length > 0)) {
					x = 0;
					y = 1;
					z = 0;
					length = 1;
				}
			}
			const o = (f * 3 + k) * 3;
			normals[o] = x / length;
			normals[o + 1] = y / length;
			normals[o + 2] = z / length;
		}
	}

	// A vertex whose corners ended up with different normals (a hard edge) is split
	const cornerVertex = new Float32Array(corners);
	for (let i = 0; i < corners; i++)
		cornerVertex[i] = triangles[i];
	const { remap, first } = dedupeRows([[cornerVertex, 1], [normals, 3]], corners);
	const source = Uint32Array.from(first, corner => triangles[corner]);
	mesh.positions = gatherRows(positions, 3, source);
	mesh.uvs = gatherRows(mesh.uvs, 2, source);
	mesh.colors = gatherRows(mesh.colors, 3, source);
	mesh.normals = gatherRows(normals, 3, first);
	mesh.triangles = remap;
	mesh.vertexCount = first.length;
	mesh.normalsComputed = true;
}

/* Finds identical rows in parallel attribute arrays ([array, size] pairs, null arrays are ignored). Returns remap
 * (row -> unique row), the number of unique rows and, for each unique row, the first original row that had it. */
function dedupeRows(attributes, count) {
	const words = [], sizes = [];
	for (const [array, size] of attributes) {
		if (!array)
			continue;
		for (let i = 0; i < array.length; i++) {
			if (array[i] === 0)
				array[i] = 0; // -0 -> +0, so both hash the same
		}
		words.push(new Uint32Array(array.buffer, array.byteOffset, array.length));
		sizes.push(size);
	}
	const lists = words.length;
	let capacity = 1;
	while (capacity < count * 2)
		capacity <<= 1;
	const mask = capacity - 1;
	const table = new Int32Array(capacity).fill(-1);
	const remap = new Uint32Array(count);
	const first = new Uint32Array(count);
	let unique = 0;
	for (let i = 0; i < count; i++) {
		let hash = 0x811C9DC5;
		for (let a = 0; a < lists; a++) {
			const w = words[a], size = sizes[a], start = i * size;
			for (let k = 0; k < size; k++)
				hash = Math.imul(hash ^ w[start + k], 0x01000193);
		}
		// Round numbers (1.0, 0.5, integer grids) differ only in the high bits of their float pattern, which the
		// multiplications above never move down: mix them into the low bits the table uses, or every vertex collides.
		hash ^= hash >>> 16;
		hash = Math.imul(hash, 0x85EBCA6B);
		hash ^= hash >>> 13;
		hash = Math.imul(hash, 0xC2B2AE35);
		hash ^= hash >>> 16;
		let slot = hash & mask;
		for (;;) {
			const found = table[slot];
			if (found < 0) {
				table[slot] = unique;
				first[unique] = i;
				remap[i] = unique++;
				break;
			}
			const row = first[found];
			let same = true;
			for (let a = 0; a < lists && same; a++) {
				const w = words[a], size = sizes[a], x = row * size, y = i * size;
				for (let k = 0; k < size; k++) {
					if (w[x + k] !== w[y + k]) {
						same = false;
						break;
					}
				}
			}
			if (same) {
				remap[i] = found;
				break;
			}
			slot = (slot + 1) & mask;
		}
	}
	return { remap, unique, first: first.subarray(0, unique) };
}

function gatherRows(array, size, rows) {
	if (!array)
		return null;
	const out = new Float32Array(rows.length * size);
	for (let i = 0; i < rows.length; i++)
		out.set(array.subarray(rows[i] * size, rows[i] * size + size), i * size);
	return out;
}

/* Merges vertices whose position, normal, UV and color are all identical. Pages often draw without an index buffer
 * (every triangle has its own three vertices), which would otherwise import as thousands of loose triangles. */
function weldVertices(mesh) {
	const { remap, unique, first } = dedupeRows([[mesh.positions, 3], [mesh.normals, 3], [mesh.uvs, 2], [mesh.colors, 3]], mesh.vertexCount);
	if (unique === mesh.vertexCount)
		return;
	mesh.positions = gatherRows(mesh.positions, 3, first);
	mesh.normals = gatherRows(mesh.normals, 3, first);
	mesh.uvs = gatherRows(mesh.uvs, 2, first);
	mesh.colors = gatherRows(mesh.colors, 3, first);
	const triangles = mesh.triangles;
	let length = 0;
	for (let i = 0; i < triangles.length; i += 3) {
		const a = remap[triangles[i]], b = remap[triangles[i + 1]], c = remap[triangles[i + 2]];
		if (a !== b && b !== c && a !== c) {
			triangles[length++] = a;
			triangles[length++] = b;
			triangles[length++] = c;
		}
	}
	mesh.triangles = triangles.slice(0, length);
	mesh.triangleCount = length / 3;
	mesh.vertexCount = unique;
}

/* OBJ indexes positions, UVs and normals separately. Writing each distinct value once keeps the mesh connected across
 * UV seams and hard edges: importers like Blender store UVs and normals per face corner, but split the mesh wherever
 * a position is repeated. Without welding every vertex keeps its own entries, as the page drew it. */
function indexAttributes(mesh, weld) {
	const n = mesh.vertexCount;
	const build = (attributes) => {
		if (!attributes[0][0])
			return null;
		if (!weld) {
			const index = new Uint32Array(n);
			for (let i = 0; i < n; i++)
				index[i] = i;
			return { index, count: n, arrays: attributes.map(([array]) => array) };
		}
		const { remap, unique, first } = dedupeRows(attributes, n);
		return { index: remap, count: unique, arrays: attributes.map(([array, size]) => gatherRows(array, size, first)) };
	};
	mesh.obj = {
		positions: build([[mesh.positions, 3], [mesh.colors, 3]]), // colors are part of the "v" line
		uvs: build([[mesh.uvs, 2]]),
		normals: build([[mesh.normals, 3]])
	};
}

const TEXT_CHUNK_SIZE = 1024 * 1024; // characters

/* Streams one mesh as OBJ text in ~1 MB pieces. Vertex data is written once to every target; faces are written per
 * target, because their indices depend on where the mesh starts in that file (target.offset: { v, vt, vn }). */
async function writeMeshOBJ(mesh, targets, encoder) {
	const { positions: P, uvs: T, normals: N } = mesh.obj;
	const [p, c] = P.arrays;
	let text = `o ${mesh.name}\n`;
	const flushShared = async () => {
		const bytes = encoder.encode(text);
		text = '';
		for (const target of targets)
			await target.write(bytes);
		await breathe();
	};
	for (let i = 0; i < P.count; i++) {
		text += `v ${formatNumber(p[i * 3])} ${formatNumber(p[i * 3 + 1])} ${formatNumber(p[i * 3 + 2])}`;
		text += c ? ` ${formatNumber(c[i * 3])} ${formatNumber(c[i * 3 + 1])} ${formatNumber(c[i * 3 + 2])}\n` : '\n';
		if (text.length >= TEXT_CHUNK_SIZE)
			await flushShared();
	}
	if (T) {
		const [t] = T.arrays;
		for (let i = 0; i < T.count; i++) {
			text += `vt ${formatNumber(t[i * 2])} ${formatNumber(t[i * 2 + 1])}\n`;
			if (text.length >= TEXT_CHUNK_SIZE)
				await flushShared();
		}
	}
	if (N) {
		const [n] = N.arrays;
		for (let i = 0; i < N.count; i++) {
			text += `vn ${formatNumber(n[i * 3])} ${formatNumber(n[i * 3 + 1])} ${formatNumber(n[i * 3 + 2])}\n`;
			if (text.length >= TEXT_CHUNK_SIZE)
				await flushShared();
		}
	}
	text += `usemtl ${mesh.material.name}\n`;
	await flushShared();

	const tri = mesh.triangles;
	for (const target of targets) {
		const bv = target.offset.v + 1, bt = target.offset.vt + 1, bn = target.offset.vn + 1;
		const corner = T && N ? (i) => `${P.index[i] + bv}/${T.index[i] + bt}/${N.index[i] + bn}`
			: T ? (i) => `${P.index[i] + bv}/${T.index[i] + bt}`
			: N ? (i) => `${P.index[i] + bv}//${N.index[i] + bn}`
			: (i) => `${P.index[i] + bv}`;
		let faces = '';
		for (let i = 0; i < tri.length; i += 3) {
			faces += `f ${corner(tri[i])} ${corner(tri[i + 1])} ${corner(tri[i + 2])}\n`;
			if (faces.length >= TEXT_CHUNK_SIZE) {
				await target.write(encoder.encode(faces));
				faces = '';
				await breathe();
			}
		}
		if (faces)
			await target.write(encoder.encode(faces));
	}
}

function timestamp(date = new Date()) {
	const p = (n) => String(n).padStart(2, '0');
	return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function saveBlob(filename, blob) {
	if (testHook && typeof testHook.onDownload === 'function') {
		testHook.onDownload(filename, blob);
		return;
	}
	const url = native.createObjectURL(blob);
	const link = apply(native.createElement, document, ['a']);
	link.href = url;
	link.download = filename;
	link.style.display = 'none';
	const parent = document.body || document.documentElement;
	apply(native.appendChild, parent, [link]);
	apply(native.click, link, []);
	apply(native.removeChild, parent, [link]);
	native.setTimeout(() => native.revokeObjectURL(url), 60000);
}

const sleep = (ms) => new Promise(resolve => native.setTimeout(resolve, ms));

/* An export runs on the page's main thread. Long loops call this to let the page render a frame (and the preview
 * respond) every few dozen milliseconds. It yields with a message: timers are throttled in background tabs. */
let yieldPort = null;
const yieldWaiters = [];
let lastYield = 0;
function breathe() {
	if (native.now() - lastYield < 30)
		return Promise.resolve();
	if (!yieldPort) {
		const channel = new native.MessageChannel();
		apply(native.setOnMessage, channel.port1, [() => {
			lastYield = native.now();
			yieldWaiters.shift()();
		}]);
		yieldPort = channel.port2;
	}
	return new Promise(resolve => {
		yieldWaiters.push(resolve);
		apply(native.postMessage, yieldPort, [0]);
	});
}

const pad = (i, total) => String(i).padStart(Math.max(3, String(total - 1).length), '0');

/* Encodes a texture as PNG once; the preview and every output format share the result. */
async function readTexturePNG(entry, unflip) {
	let image = null;
	try {
		image = entry.context.openTexture(entry.texture);
		if (!image)
			return null;
		const data = new BlobCollector();
		let crc = -1;
		const { opaque } = await encodePNG(image.width, image.height, image.readRows, unflip, async (bytes) => {
			crc = crc32Update(crc, bytes);
			data.push(bytes);
		});
		return { blob: data.toBlob('image/png'), crc: (crc ^ -1) >>> 0, width: image.width, height: image.height, opaque };
	} catch (err) {
		log('Texture readback failed:', err);
		return null;
	} finally {
		if (image)
			image.close();
	}
}

/* Materials are shared by meshes that use the same textures, color and render state. */
function buildMaterials(meshes) {
	const clamp = (c) => Math.min(Math.max(c, 0), 1);
	const materials = new Map();
	for (const mesh of meshes) {
		const slots = mesh.textures.filter(t => t.entry && t.entry.png);
		const color = mesh.color ? mesh.color.map(clamp) : null;
		const emissive = mesh.emissive && mesh.emissive.slice(0, 3).some(c => c > 0) ? mesh.emissive.slice(0, 3).map(clamp) : null;
		const signature = [slots.map(t => `${t.slot}=${t.entry.index}`).join(';'), color, emissive, mesh.blend, mesh.doubleSided].join('|');
		let material = materials.get(signature);
		if (!material) {
			material = { name: `mat_${pad(materials.size, meshes.length)}`, slots, color, emissive, blend: mesh.blend, doubleSided: mesh.doubleSided };
			materials.set(signature, material);
		}
		mesh.material = material;
	}
}

/* Puts the exported meshes on the origin: centered horizontally, standing on y = 0. */
function centerMeshes(meshes) {
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (const mesh of meshes) {
		const p = mesh.positions;
		for (let i = 0; i < p.length; i += 3) {
			for (let k = 0; k < 3; k++) {
				if (p[i + k] < lo[k]) lo[k] = p[i + k];
				if (p[i + k] > hi[k]) hi[k] = p[i + k];
			}
		}
	}
	if (!(lo[0] <= hi[0]))
		return null;
	const shift = [-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2];
	for (const mesh of meshes) {
		const p = mesh.positions;
		for (let i = 0; i < p.length; i += 3) {
			p[i] += shift[0];
			p[i + 1] += shift[1];
			p[i + 2] += shift[2];
		}
	}
	return shift;
}

/* Reads back the textures in `entries` that weren't read yet, as PNG. A failed texture gets png = null. */
async function readTextures(capture, entries, progress) {
	const pending = entries.filter(entry => entry.png === undefined);
	try {
		for (let i = 0; i < pending.length; i++) {
			progress(`Reading texture ${i + 1} of ${pending.length}…`);
			pending[i].png = await readTexturePNG(pending[i], capture.settings.unflip);
		}
	} finally {
		for (const context of capture.contexts.values())
			context.disposeReader();
	}
}

/* Everything that happens once per capture before anything is written or shown: meshes are finalized and textures
 * read back as PNG. With the preview only base color textures are read here (that is what it shows); the others
 * follow after the choice, for the meshes that are downloaded. */
async function prepareCapture(capture, progress, previewing) {
	const meshes = finalizeMeshes(capture);
	capture.meshes = []; // dropped duplicates can be garbage collected now
	if (!meshes.length) {
		let message = `No triangle meshes were found in ${capture.drawCount} draw call(s).`;
		if (capture.unrecognizedAttributes.size) {
			const sample = Array.from(capture.unrecognizedAttributes).slice(0, 3).join(' | ');
			message += ` Unrecognized vertex attributes: ${sample}. Add the position attribute name under Options → Advanced.`;
		}
		throw new RipperError(message);
	}
	meshes.forEach((mesh, i) => { mesh.name = `mesh_${pad(i, meshes.length)}`; });

	// Without the preview only the picked mesh is exported, so only its textures are needed
	const needed = previewing || !capture.pick ? meshes : meshes.filter(mesh => mesh.picked);
	const textures = [];
	const byContext = new Map();
	for (const mesh of needed) {
		for (const t of mesh.textures) {
			let perContext = byContext.get(mesh.context);
			if (!perContext)
				byContext.set(mesh.context, perContext = new Map());
			let entry = perContext.get(t.texture);
			if (!entry) {
				entry = { context: mesh.context, texture: t.texture, index: textures.length, png: undefined, baseColor: false };
				perContext.set(t.texture, entry);
				textures.push(entry);
			}
			if (t.slot === 'map_Kd')
				entry.baseColor = true;
			t.entry = entry;
		}
	}
	await readTextures(capture, previewing ? textures.filter(entry => entry.baseColor) : textures, progress);
	buildMaterials(needed);
	return { meshes, textures };
}

const GLB_FLOAT = 5126, GLB_UNSIGNED_SHORT = 5123, GLB_UNSIGNED_INT = 5125;
const GLB_ARRAY_BUFFER = 34962, GLB_ELEMENT_ARRAY_BUFFER = 34963;

/* glTF 2.0 binary: one node per mesh, PBR materials, PNG textures embedded. Built from Blob parts, so the geometry
 * and textures are not copied into one big buffer. */
function buildGLB(meshes, flipV, extras) {
	const json = {
		asset: { version: '2.0', generator: `WebGL Ripper ${engineVersion}`, extras },
		scene: 0,
		scenes: [{ name: 'WebGL Ripper', nodes: [] }],
		nodes: [],
		meshes: [],
		materials: [],
		accessors: [],
		bufferViews: [],
		buffers: []
	};
	const parts = [];
	let length = 0;
	const align = () => {
		const padding = (4 - (length % 4)) % 4;
		if (padding) {
			parts.push(new Uint8Array(padding));
			length += padding;
		}
	};
	const addView = (data, target) => {
		align();
		const size = data instanceof native.Blob ? data.size : data.byteLength;
		json.bufferViews.push(target ? { buffer: 0, byteOffset: length, byteLength: size, target } : { buffer: 0, byteOffset: length, byteLength: size });
		parts.push(data instanceof native.Blob ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		length += size;
		return json.bufferViews.length - 1;
	};
	const addAccessor = (array, type, componentType, count, target, extra) => {
		json.accessors.push({ bufferView: addView(array, target), componentType, count, type, ...extra });
		return json.accessors.length - 1;
	};

	const textureIndex = new Map();
	const textureOf = (slot) => {
		if (!slot || !slot.entry || !slot.entry.png)
			return undefined;
		let index = textureIndex.get(slot.entry);
		if (index === undefined) {
			json.images = json.images || [];
			json.textures = json.textures || [];
			json.samplers = json.samplers || [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
			json.images.push({ name: `tex_${pad(slot.entry.index, 1)}`, bufferView: addView(slot.entry.png.blob), mimeType: 'image/png' });
			json.textures.push({ sampler: 0, source: json.images.length - 1 });
			textureIndex.set(slot.entry, index = json.textures.length - 1);
		}
		return index;
	};

	const materialIndex = new Map();
	const materialOf = (material) => {
		let index = materialIndex.get(material);
		if (index !== undefined)
			return index;
		const slot = (name) => material.slots.find(t => t.slot === name);
		const base = slot('map_Kd'), normal = slot('map_Bump'), emissive = slot('map_Ke');
		const roughness = slot('map_Pr'), metalness = slot('map_Pm');
		const occlusion = material.slots.find(t => t.slot === 'extra' && /occlu|(^|[^a-z])ao/i.test(t.uniform));
		const pbr = { baseColorFactor: material.color || [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 };
		const out = { name: material.name, pbrMetallicRoughness: pbr, doubleSided: !!material.doubleSided };
		if (base)
			pbr.baseColorTexture = { index: textureOf(base) };
		// glTF packs roughness (G) and metalness (B) in one texture, which is how three.js samples them too
		if (roughness && metalness && roughness.entry === metalness.entry) {
			pbr.metallicRoughnessTexture = { index: textureOf(roughness) };
			pbr.metallicFactor = 1;
		}
		if (normal)
			out.normalTexture = { index: textureOf(normal) };
		if (occlusion)
			out.occlusionTexture = { index: textureOf(occlusion) };
		if (emissive) {
			out.emissiveTexture = { index: textureOf(emissive) };
			out.emissiveFactor = [1, 1, 1];
		} else if (material.emissive) {
			out.emissiveFactor = material.emissive;
		}
		const translucent = (base && base.entry.png && !base.entry.png.opaque) || pbr.baseColorFactor[3] < 1;
		if (material.blend && translucent)
			out.alphaMode = 'BLEND';
		json.materials.push(out);
		materialIndex.set(material, index = json.materials.length - 1);
		return index;
	};

	for (const mesh of meshes) {
		const count = mesh.vertexCount;
		const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		for (let i = 0; i < count * 3; i += 3) {
			for (let k = 0; k < 3; k++) {
				const v = mesh.positions[i + k];
				if (v < lo[k]) lo[k] = v;
				if (v > hi[k]) hi[k] = v;
			}
		}
		const attributes = {
			POSITION: addAccessor(mesh.positions, 'VEC3', GLB_FLOAT, count, GLB_ARRAY_BUFFER, { min: lo, max: hi })
		};
		if (mesh.normals)
			attributes.NORMAL = addAccessor(mesh.normals, 'VEC3', GLB_FLOAT, count, GLB_ARRAY_BUFFER);
		if (mesh.uvs) {
			let uvs = mesh.uvs;
			if (flipV) {
				// The PNGs are stored the way OBJ expects (origin bottom left); glTF puts the origin at the top
				uvs = Float32Array.from(uvs);
				for (let i = 1; i < uvs.length; i += 2)
					uvs[i] = 1 - uvs[i];
			}
			attributes.TEXCOORD_0 = addAccessor(uvs, 'VEC2', GLB_FLOAT, count, GLB_ARRAY_BUFFER);
		}
		if (mesh.colors)
			attributes.COLOR_0 = addAccessor(mesh.colors, 'VEC3', GLB_FLOAT, count, GLB_ARRAY_BUFFER);
		const small = count <= 65535;
		const indices = small ? Uint16Array.from(mesh.triangles) : mesh.triangles;
		const primitive = {
			attributes,
			indices: addAccessor(indices, 'SCALAR', small ? GLB_UNSIGNED_SHORT : GLB_UNSIGNED_INT, indices.length, GLB_ELEMENT_ARRAY_BUFFER),
			mode: 4
		};
		if (mesh.material)
			primitive.material = materialOf(mesh.material);
		json.meshes.push({ name: mesh.name, primitives: [primitive] });
		json.nodes.push({ name: mesh.name, mesh: json.meshes.length - 1 });
		json.scenes[0].nodes.push(json.nodes.length - 1);
	}
	align();
	json.buffers.push({ byteLength: length });
	if (!json.materials.length)
		delete json.materials;

	let text = native.stringify(json);
	text += ' '.repeat((4 - (new native.TextEncoder().encode(text).length % 4)) % 4);
	const jsonBytes = new native.TextEncoder().encode(text);
	const header = new Uint8Array(20);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x46546C67, true);    // "glTF"
	view.setUint32(4, 2, true);
	view.setUint32(8, 12 + 8 + jsonBytes.length + 8 + length, true);
	view.setUint32(12, jsonBytes.length, true);
	view.setUint32(16, 0x4E4F534A, true);   // "JSON"
	const binHeader = new Uint8Array(8);
	new DataView(binHeader.buffer).setUint32(0, length, true);
	new DataView(binHeader.buffer).setUint32(4, 0x004E4942, true); // "BIN"
	return new native.Blob([header, jsonBytes, binHeader, ...parts], { type: 'model/gltf-binary' });
}

/* Blob streams can hand out a whole part at once (megabytes of geometry): it is passed on in 1 MB pieces, so
 * compressing it doesn't freeze the page. */
async function pipeBlob(blob, write) {
	const reader = blob.stream().getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done)
			return;
		for (let start = 0; start < value.length; start += 1 << 20) {
			await write(value.subarray(start, start + (1 << 20)));
			await breathe();
		}
	}
}

async function writeOBJ(meshes, textures, settings, output, prefix, zip, encoder, progress) {
	for (const entry of textures) {
		entry.file = `${zip ? 'textures/' : prefix}tex_${pad(entry.index, textures.length)}.png`;
		await output.addStored(entry.file, entry.png.blob, entry.png.crc);
	}

	const materials = new Set(meshes.map(mesh => mesh.material));
	const mtlName = `${prefix}materials.mtl`;
	const mtl = ['# WebGL Ripper material library'];
	const number = (c) => formatNumber(c);
	for (const material of materials) {
		mtl.push('', `newmtl ${material.name}`);
		const color = material.color || (material.slots.some(t => t.slot === 'map_Kd') ? [1, 1, 1, 1] : [0.8, 0.8, 0.8, 1]);
		mtl.push(`Kd ${color.slice(0, 3).map(number).join(' ')}`, 'Ka 0 0 0', 'Ks 0 0 0', `d ${number(color[3])}`, 'illum 1');
		if (material.emissive)
			mtl.push(`Ke ${material.emissive.map(number).join(' ')}`);
		for (const t of material.slots) {
			if (t.slot === 'extra')
				mtl.push(`# ${t.uniform}: ${t.entry.file}`);
			else
				mtl.push(`${t.slot} ${t.entry.file}`);
		}
	}
	const mtlFile = output.open(mtlName, true);
	await mtlFile.write(encoder.encode(mtl.join('\n') + '\n'));
	await mtlFile.close();

	const header = encoder.encode(`# Exported by WebGL Ripper ${engineVersion}\n# Source: ${location.href}\nmtllib ${mtlName}\n`);
	let combined = null;
	if (settings.layout !== 'separate') {
		combined = output.open(`${prefix}scene.obj`, true);
		await combined.write(header);
	}
	const offset = { v: 0, vt: 0, vn: 0 }; // where the next mesh starts in scene.obj
	let lastProgress = 0;
	for (let i = 0; i < meshes.length; i++) {
		const mesh = meshes[i];
		if (native.now() - lastProgress > 250) {
			lastProgress = native.now();
			progress(`Writing mesh ${i + 1} of ${meshes.length}…`);
		}
		indexAttributes(mesh, settings.weldVertices);
		mesh.positionCount = mesh.obj.positions.count;
		const targets = [];
		let file = null;
		if (settings.layout !== 'combined') {
			file = output.open(`${prefix}${mesh.name}.obj`, true);
			await file.write(header);
			targets.push({ write: file.write, offset: { v: 0, vt: 0, vn: 0 } });
		}
		if (combined)
			targets.push({ write: combined.write, offset: { ...offset } });
		await writeMeshOBJ(mesh, targets, encoder);
		if (file)
			await file.close();
		offset.v += mesh.obj.positions.count;
		offset.vt += mesh.obj.uvs ? mesh.obj.uvs.count : 0;
		offset.vn += mesh.obj.normals ? mesh.obj.normals.count : 0;
		mesh.obj = null;
	}
	if (combined)
		await combined.close();
}

/* Writes the chosen meshes in the chosen format: a .glb on its own, or OBJ files (zipped or not), or both. */
async function writeExport(capture, scene, meshes, format, progress) {
	const settings = capture.settings;
	const stamp = timestamp();
	const host = (location.hostname || 'page').replace(/[^a-z0-9.-]+/gi, '_');
	const shift = settings.center ? centerMeshes(meshes) : null;
	const used = scene.textures.filter(entry => meshes.some(mesh => mesh.textures.some(t => t.entry === entry)));
	const textures = used.filter(entry => entry.png);
	const wantOBJ = format !== 'glb', wantGLB = format !== 'obj';
	const zip = wantOBJ && settings.zip;
	const prefix = zip ? '' : `webglripper_${stamp}_`;
	const encoder = new native.TextEncoder();
	const output = zip ? new ZipBuilder() : new DownloadOutput();
	const extras = { source: location.href, capturedAt: new Date().toISOString(), offset: shift };

	if (wantOBJ)
		await writeOBJ(meshes, textures, settings, output, prefix, zip, encoder, progress);

	let filename = zip ? `webglripper_${host}_${stamp}.zip` : `${prefix}*`;
	if (wantGLB) {
		progress('Building GLB…');
		const glb = buildGLB(meshes, settings.unflip, extras);
		if (zip) {
			const file = output.open('model.glb', true);
			await pipeBlob(glb, file.write);
			await file.close();
		} else {
			const name = wantOBJ ? `${prefix}model.glb` : `webglripper_${host}_${stamp}.glb`;
			saveBlob(name, glb);
			output.count++;
			if (!wantOBJ)
				filename = name;
		}
	}

	const summary = {
		meshes: meshes.length,
		textures: textures.length,
		failedTextures: used.length - textures.length,
		drawCalls: capture.drawCount,
		skipped: { ...capture.stats },
		format
	};
	if (zip) {
		const info = output.open('rip-info.json', true);
		await info.write(encoder.encode(native.stringify({
			tool: 'WebGL Ripper',
			version: engineVersion,
			url: location.href,
			capturedAt: extras.capturedAt,
			settings: { ...settings, names: undefined },
			offset: shift,
			contexts: Array.from(capture.contexts.values()).map(c => c.describe()),
			summary,
			unrecognizedAttributes: Array.from(capture.unrecognizedAttributes),
			meshes: meshes.map(mesh => ({
				name: mesh.name,
				context: mesh.context.index,
				draw: mesh.draw,
				mode: MODE_NAMES[mesh.mode],
				vertices: mesh.positionCount || mesh.vertexCount,
				triangles: mesh.triangleCount,
				attributes: mesh.program,
				normals: mesh.normalsComputed ? 'computed' : mesh.normals ? 'from page' : 'none',
				transform: mesh.transform,
				viewport: mesh.viewport,
				matrix: mesh.matrix && mesh.matrix.m ? { kind: mesh.matrix.kind, values: Array.from(mesh.matrix.m, v => +v.toFixed(6)) } : null,
				material: mesh.material.name,
				textures: mesh.textures.map(t => ({ slot: t.slot, uniform: t.uniform, file: t.entry ? t.entry.file || null : null }))
			}))
		}, null, '\t')));
		await info.close();
		progress('Packing .zip…');
		saveBlob(filename, output.toBlob());
	}
	return { ...summary, files: output.count, filename };
}

/* What the preview overlay gets: geometry for display and the base color texture of each mesh. */
function previewData(capture, scene) {
	return {
		title: location.hostname || document.title || 'page',
		format: capture.settings.format,
		flipV: capture.settings.unflip,
		meshes: scene.meshes.map(mesh => {
			const base = mesh.textures.find(t => t.slot === 'map_Kd' && t.entry && t.entry.png);
			return {
				name: mesh.name,
				positions: mesh.positions,
				normals: mesh.normals,
				uvs: mesh.uvs,
				triangles: mesh.triangles,
				vertexCount: mesh.vertexCount,
				triangleCount: mesh.triangleCount,
				color: mesh.material ? mesh.material.color : mesh.color,
				texture: base ? base.entry.png.blob : null,
				textureWidth: base ? base.entry.png.width : 0,
				textureHeight: base ? base.entry.png.height : 0,
				picked: !!mesh.picked,
				selected: capture.pick ? !!mesh.picked : true
			};
		})
	};
}

/* ------------------------------------------------------------------------------------------------------------
 * Capture lifecycle and messaging with bridge.js.
 * ---------------------------------------------------------------------------------------------------------- */

let engineVersion = 'dev';
let rawSettings = null;
let pendingCapture = false;
let exporting = false;
let status = { state: 'idle', text: '', result: null };

function emit(message) {
	const event = new native.CustomEvent(TO_EXTENSION, { detail: native.stringify(message) });
	apply(native.dispatchEvent, document, [event]);
}

function setStatus(state, text, result = null) {
	status = { state, text, result };
	emit({ type: 'state', ...status });
	if (state === 'error')
		native.warn('[WebGLRipper]', text);
	else if (state === 'done')
		native.info('[WebGLRipper]', text);
	else
		log(text);
}

let contextsReportTimer = 0;
function scheduleContextsReport() {
	if (contextsReportTimer)
		return;
	contextsReportTimer = native.setTimeout(() => {
		contextsReportTimer = 0;
		emit({ type: 'contexts', count: visibleContextCount() });
	}, 300);
}

function applySettings(settings) {
	if (!settings || typeof settings !== 'object')
		return;
	rawSettings = settings;
	debugEnabled = !!settings.is_debug_mode;
	if (settings.__version)
		engineVersion = String(settings.__version);
}

function requestCapture(pick = null) {
	if (session || pendingCapture || exporting || pickMode) {
		emit({ type: 'state', ...status });
		return;
	}
	if (!liveContexts().length) {
		setStatus('idle', 'No WebGL content in this frame.');
		return;
	}
	if (typeof native.CompressionStream !== 'function') {
		setStatus('error', 'This browser is too old: CompressionStream is not supported.');
		return;
	}

	const capture = new CaptureSession(normalizeSettings(rawSettings));
	capture.pick = pick;
	pendingCapture = true;
	setStatus('waiting', 'Waiting for the next frame…');

	const giveUp = native.setTimeout(() => {
		if (session === capture || pendingCapture) {
			capture.removeHooks();
			session = null;
			pendingCapture = false;
			setStatus('error', 'Nothing was rendered within 15 seconds. Keep the tab visible and make sure the scene is animating (move the camera if it only renders on demand).');
		}
	}, CAPTURE_TIMEOUT_MS);

	// Start right after this frame's callbacks so the next frame is recorded from its very first draw call,
	// then keep going until a frame that actually drew something has finished.
	native.requestAnimationFrame(() => {
		if (!pendingCapture)
			return;
		pendingCapture = false;
		session = capture;
		capture.removeHooks = installCaptureHooks(!!capture.pick);
		capture.startedAt = native.now();
		setStatus('capturing', 'Recording a frame…');
		const tick = () => {
			if (session !== capture)
				return;
			if (capture.drawCount === 0) {
				native.requestAnimationFrame(tick);
				return;
			}
			session = null;
			capture.removeHooks();
			native.clearTimeout(giveUp);
			finishCapture(capture);
		};
		native.requestAnimationFrame(tick);
	});
}

async function finishCapture(capture) {
	exporting = true;
	// Only needed while recording; GPU buffer copies in particular can be large
	for (const context of capture.contexts.values()) {
		context.bufferCache.clear();
		context.programs.clear();
	}
	capture.uniforms.clear();
	capture.exactKeys.clear();
	const progress = (text) => setStatus('exporting', text);
	setStatus('exporting', `Recorded ${capture.meshes.length} mesh(es) from ${capture.drawCount} draw call(s)…`);
	try {
		const chooser = testHook && typeof testHook.onPreview === 'function' ? testHook.onPreview
			: viewerApi ? (data) => viewerApi.open(data) : null;
		const previewing = capture.settings.preview && !!chooser;
		const scene = await prepareCapture(capture, progress, previewing);
		let meshes = capture.pick ? scene.meshes.filter(mesh => mesh.picked) : scene.meshes;
		let format = capture.settings.format;
		if (previewing) {
			setStatus('preview', 'Choose what to keep in the page, then press Download.');
			const choice = await chooser(previewData(capture, scene));
			if (!choice || !choice.selected || !choice.selected.length) {
				setStatus('idle', 'Cancelled, nothing was downloaded.');
				return;
			}
			meshes = choice.selected.map(i => scene.meshes[i]).filter(Boolean);
			if (['glb', 'obj', 'both'].includes(choice.format))
				format = choice.format;
			// the other maps of the chosen meshes; textures of meshes that were only shown are never read
			await readTextures(capture, scene.textures.filter(entry => meshes.some(mesh => mesh.textures.some(t => t.entry === entry))), progress);
			buildMaterials(meshes);
		}
		const result = await writeExport(capture, scene, meshes, format, progress);
		let text = `Saved ${result.meshes} mesh(es) and ${result.textures} texture(s)`;
		text += result.failedTextures ? ` (${result.failedTextures} texture(s) could not be read).` : '.';
		setStatus('done', text, result);
	} catch (err) {
		if (!(err instanceof RipperError))
			native.warn('[WebGLRipper] Export failed:', err);
		setStatus('error', err instanceof RipperError ? err.message : `Export failed: ${err && err.message || err}`);
	} finally {
		exporting = false;
	}
}

/* Pick mode: the next click on a WebGL canvas rips just the object under the cursor. */
let pickMode = null;

function webglCanvasAt(x, y) {
	for (const element of apply(native.elementsFromPoint, document, [x, y])) {
		if (element instanceof HTMLCanvasElement && contextOfCanvas.has(element))
			return element;
	}
	return null;
}

function startPickMode() {
	if (session || pendingCapture || exporting) {
		emit({ type: 'state', ...status });
		return;
	}
	if (pickMode)
		return;
	const canvases = liveContexts().map(gl => gl.canvas).filter(c => c instanceof HTMLCanvasElement && c.isConnected);
	if (!canvases.length) {
		setStatus('idle', 'No WebGL content in this frame.');
		return;
	}
	const cursors = canvases.map(canvas => [canvas, canvas.style.cursor]);
	for (const canvas of canvases)
		canvas.style.cursor = 'crosshair';
	const listeners = [];
	const listen = (type, handler) => {
		apply(native.addEventListener, window, [type, handler, true]);
		listeners.push([type, handler]);
	};
	const swallow = (event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	const finish = () => {
		for (const [type, handler] of listeners)
			apply(native.removeEventListener, window, [type, handler, true]);
		listeners.length = 0;
		for (const [canvas, cursor] of cursors)
			canvas.style.cursor = cursor;
		native.clearTimeout(timeout);
		if (viewerApi)
			viewerApi.hint(null);
		pickMode = null;
	};
	const timeout = native.setTimeout(() => {
		finish();
		setStatus('idle', 'Pick mode ended.');
	}, 60000);
	listen('pointerdown', (event) => {
		const canvas = webglCanvasAt(event.clientX, event.clientY);
		if (!canvas)
			return;
		swallow(event);
		const rect = canvas.getBoundingClientRect();
		const pick = {
			gl: contextOfCanvas.get(canvas),
			x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 0.9999),
			y: Math.min(Math.max(1 - (event.clientY - rect.top) / rect.height, 0), 0.9999)
		};
		finish();
		// The rest of this click belongs to us as well. Only the user's own events are eaten: the export's
		// download link is clicked from script and must get through.
		const rest = ['pointerup', 'mousedown', 'mouseup', 'click', 'contextmenu'];
		const release = () => {
			for (const type of rest)
				apply(native.removeEventListener, window, [type, eat, true]);
		};
		const eat = (e) => {
			if (!e.isTrusted)
				return;
			swallow(e);
			if (e.type === 'click' || e.type === 'contextmenu')
				release();
		};
		for (const type of rest)
			apply(native.addEventListener, window, [type, eat, true]);
		native.setTimeout(release, 1000);
		requestCapture(pick);
	});
	listen('keydown', (event) => {
		if (event.key !== 'Escape')
			return;
		swallow(event);
		finish();
		setStatus('idle', 'Pick mode cancelled.');
	});
	pickMode = { finish };
	if (viewerApi)
		viewerApi.hint('Click the object you want to rip · Esc to cancel');
	setStatus('picking', 'Click the object you want to rip in the page.');
}

function onCommand(event) {
	let message;
	try {
		message = typeof event.detail === 'string' ? native.parse(event.detail) : null;
	} catch (err) {
		return;
	}
	if (!message || typeof message !== 'object')
		return;
	switch (message.type) {
		case 'hello':
			emit({ type: 'ready', contexts: visibleContextCount(), ...status });
			break;
		case 'settings':
			applySettings(message.settings);
			break;
		case 'capture':
			applySettings(message.settings);
			requestCapture();
			break;
		case 'pick':
			applySettings(message.settings);
			startPickMode();
			break;
	}
}

installHooks();
apply(native.addEventListener, document, [TO_PAGE, onCommand]);
emit({ type: 'ready', contexts: 0, ...status });

if (testHook) {
	testHook.internals = {
		classifyAttribute, classifyTexture, classifyMatrix, normalizeSettings, triangulate, compactVertices,
		halfToFloat, invert4, multiply4, normalMatrix, crc32, encodePNG, ZipBuilder, formatNumber, classifyColorUniform,
		isRenderTarget: (texture) => renderTargetTextures.has(texture), dedupeRows,
		status: () => status
	};
}
})();
