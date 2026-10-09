/* Self-checking tests for webglripper.js. Open tests/engine.html (any static server or file://). */
'use strict';

const T = window.__WEBGLRIPPER_TEST__;
const I = T.internals;
const results = [];
const logElement = document.getElementById('log');

function check(name, condition, detail) {
	results.push({ name, pass: !!condition, detail });
	const line = document.createElement('div');
	line.className = condition ? 'pass' : 'fail';
	let text = `${condition ? 'PASS' : 'FAIL'}  ${name}`;
	if (!condition && detail !== undefined)
		text += `  —  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
	line.textContent = text;
	logElement.appendChild(line);
}

const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
const nearArray = (a, b, eps = 1e-4) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));
const translation = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const scale = (s) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
const VIEW_PROJECTION = scale(0.05);

function buildProgram(gl, vs, fs, bindings) {
	const compile = (type, source) => {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
			throw new Error(gl.getShaderInfoLog(shader));
		return shader;
	};
	const program = gl.createProgram();
	gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
	gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
	for (const [name, location] of Object.entries(bindings || {}))
		gl.bindAttribLocation(program, location, name);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS))
		throw new Error(gl.getProgramInfoLog(program));
	return program;
}

function toHalf(value) {
	// enough for the exact values used in these tests
	if (value === 0) return 0;
	const exponent = Math.floor(Math.log2(Math.abs(value)));
	const fraction = Math.round((Math.abs(value) / Math.pow(2, exponent) - 1) * 1024);
	return (value < 0 ? 0x8000 : 0) | ((exponent + 15) << 10) | fraction;
}

/* ------------------------------------------------------------------------------------------------------------
 * Unit tests of the engine internals
 * ---------------------------------------------------------------------------------------------------------- */

function unitTests() {
	const names = I.normalizeSettings({}).names;
	const attr = (n) => (I.classifyAttribute(n, names) || [null])[0];
	check('attribute: three.js position', attr('position') === 'position');
	check('attribute: Unity in_POSITION0', attr('in_POSITION0') === 'position');
	check('attribute: Unity WebGL1 _glesVertex', attr('_glesVertex') === 'position');
	check('attribute: PlayCanvas vertex_texCoord0', attr('vertex_texCoord0') === 'uv');
	check('attribute: Pixi aTextureCoord', attr('aTextureCoord') === 'uv');
	check('attribute: Godot normal_attrib', attr('normal_attrib') === 'normal');
	check('attribute: vertex color', attr('a_color') === 'color');
	check('attribute: secondary UV set rejected', attr('in_TEXCOORD1') === null);
	check('attribute: instanced world0 rejected', attr('world0') === null);
	check('attribute: skinIndex rejected', attr('skinIndex') === null);
	check('attribute: position3DHigh rejected', attr('position3DHigh') === null);
	const custom = I.normalizeSettings({ extra_position_names: 'in_ATTRIBUTE0, foo' }).names;
	check('attribute: user supplied name', (I.classifyAttribute('in_ATTRIBUTE0', custom) || [])[0] === 'position');

	const texture = (n) => I.classifyTexture(n, [])[0];
	check('texture: three.js map', texture('map') === 'map_Kd');
	check('texture: Unity _MainTex', texture('_MainTex') === 'map_Kd');
	check('texture: Unity _BumpMap', texture('_BumpMap') === 'map_Bump');
	check('texture: _MetallicGlossMap', texture('_MetallicGlossMap') === 'map_Pm');
	check('texture: Babylon diffuseSampler', texture('diffuseSampler') === 'map_Kd');
	check('texture: PlayCanvas texture_diffuseMap', texture('texture_diffuseMap') === 'map_Kd');
	check('texture: shadow maps excluded', texture('directionalShadowMap') === 'exclude');
	check('texture: environment excluded', texture('envMap') === 'exclude' && texture('texture_envAtlas') === 'exclude');
	check('texture: bone data excluded', texture('boneTexture') === 'exclude');
	check('texture: aoMap kept as extra', texture('aoMap') === 'extra');
	check('texture: _EmissionMap is emissive (not a normal map)', texture('_EmissionMap') === 'map_Ke');
	check('texture: unknown sampler', texture('uFoo') === 'unknown');

	const matrix = (n) => I.classifyMatrix(n, []);
	check('matrix: modelMatrix', matrix('modelMatrix') === 'model');
	check('matrix: modelViewMatrix', matrix('modelViewMatrix') === 'modelView');
	check('matrix: Babylon world', matrix('world') === 'model');
	check('matrix: Unity hlslcc array', matrix('hlslcc_mtx4x4unity_ObjectToWorld[0]') === 'model');
	check('matrix: uMVMatrix', matrix('uMVMatrix') === 'modelView');
	check('matrix: uniform block member', matrix('Mesh.world') === 'model');
	check('matrix: viewProjection is not a model matrix', matrix('viewProjection') === 'viewProjection');
	check('matrix: projection and model-view-projection', matrix('projectionMatrix') === 'projection' && matrix('uPMatrix') === 'projection' &&
		matrix('u_mvp') === 'mvp' && matrix('hlslcc_mtx4x4unity_MatrixVP[0]') === 'viewProjection');

	const color = (n) => I.classifyColorUniform(n);
	check('color: three.js diffuse / u_color / Unity _Color', color('diffuse') === 'base' && color('u_color') === 'base' && color('_Color') === 'base');
	check('color: material struct member', color('material.baseColor') === 'base' && color('u_material.emissive') === 'emissive');
	check('color: light colors are not material colors', color('directionalLights[0].color') === null &&
		color('pointLights[2].color') === null && color('u_light.color') === null && color('fogColor') === null);
	check('color: any other surface color as a fallback, not backgrounds or wireframes', color('uPartColor') === 'other' &&
		color('segmentColor') === 'other' && color('uBgColor1') === null && color('wireframeColor') === null && color('uHighlightColor') === null);

	const factor = (n) => I.classifyFactor(n);
	check('factors: roughness and metalness uniforms', factor('roughness') === 'roughness' && factor('metalness') === 'metalness' &&
		factor('material_metalness') === 'metalness' && factor('u_roughnessIntensity') === null);
	const types = (entries) => new Map(entries.map(([name, type]) => [name, { type }]));
	const MAT3 = 0x8B5B, MAT4 = 0x8B5C, VEC3 = 0x8B51, VEC4 = 0x8B52;
	const uvt = (sampler, entries) => { const t = I.uvTransformUniform(sampler, types(entries)); return t && `${t.kind}:${t.names.join(',')}`; };
	check('uv transforms: three.js, Unity, Babylon.js, PlayCanvas', uvt('map', [['mapTransform', MAT3]]) === 'mat3:mapTransform' &&
		uvt('map', [['uvTransform', MAT3]]) === 'mat3:uvTransform' && uvt('normalMap', [['uvTransform', MAT3]]) === null &&
		uvt('_MainTex', [['_MainTex_ST', VEC4]]) === 'st:_MainTex_ST' && uvt('diffuseSampler', [['diffuseMatrix', MAT4]]) === 'mat4:diffuseMatrix' &&
		uvt('texture_diffuseMap', [['texture_diffuseMapTransform0', VEC3], ['texture_diffuseMapTransform1', VEC3]]) === 'rows:texture_diffuseMapTransform0,texture_diffuseMapTransform1');
	const uvs = Float32Array.from([0, 0, 4095 / 65535, 4095 / 65535]);
	I.transformUVs(uvs, [65535 / 4095, 0, 0, 65535 / 4095, 0, 0]);
	check('uv transforms: 12-bit coordinates stretched back to 0..1', nearArray(Array.from(uvs), [0, 0, 1, 1], 1e-6), Array.from(uvs));

	const strip = Array.from(I.triangulate(5, Uint32Array.from([0, 1, 2, 3, 0xFFFFFFFF, 4, 5, 6]), 0xFFFFFFFF));
	check('triangulate: strip with primitive restart', nearArray(strip, [0, 1, 2, 2, 1, 3, 4, 5, 6], 0), strip);
	const fan = Array.from(I.triangulate(6, Uint32Array.from([0, 1, 2, 3]), -1));
	check('triangulate: fan', nearArray(fan, [0, 1, 2, 0, 2, 3], 0), fan);
	check('triangulate: degenerate triangles dropped', I.triangulate(4, Uint32Array.from([0, 0, 1, 2, 3, 4]), -1).length === 3);
	const compact = I.compactVertices(Uint32Array.from([10, 12, 11, 12, 11, 13]));
	check('compact vertices', nearArray(Array.from(compact.remapped), [0, 1, 2, 1, 2, 3], 0) &&
		nearArray(Array.from(compact.unique), [10, 12, 11, 13], 0));
	check('half floats', I.halfToFloat(0x3C00) === 1 && I.halfToFloat(0xC000) === -2 && near(I.halfToFloat(0x3555), 1 / 3, 1e-3));
	check('crc32', I.crc32([new TextEncoder().encode('123456789')]) === 0xCBF43926);
	const crcBytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 131) ^ (i >> 3));
	let crcReference = -1;
	for (const byte of crcBytes) {
		crcReference ^= byte;
		for (let k = 0; k < 8; k++)
			crcReference = crcReference & 1 ? 0xEDB88320 ^ (crcReference >>> 1) : crcReference >>> 1;
	}
	check('crc32 over several chunks of odd sizes matches the bitwise definition',
		I.crc32([crcBytes.subarray(0, 7), crcBytes.subarray(7, 500), crcBytes.subarray(500)]) === ((crcReference ^ -1) >>> 0));
	// Welding a triangle soup on an integer grid: round floats differ only in their high bits
	const cells = 150, soup = new Float32Array((cells * cells * 6) * 3);
	for (let y = 0, o = 0; y < cells; y++)
		for (let x = 0; x < cells; x++)
			for (const [dx, dy] of [[0, 0], [0, 1], [1, 0], [1, 0], [0, 1], [1, 1]])
				soup.set([x + dx, 0, y + dy], (o++) * 3);
	const weldStart = performance.now();
	const welded = I.dedupeRows([[soup, 3]], soup.length / 3);
	const weldMs = performance.now() - weldStart;
	check('welding round coordinates is fast (no hash collisions)', welded.unique === (cells + 1) * (cells + 1) && weldMs < 1000, { unique: welded.unique, ms: weldMs });
	check('number formatting', I.formatNumber(0.30000001192092896) === '0.3' && I.formatNumber(-1e-7) === '0' && I.formatNumber(NaN) === '0');
	const m = I.multiply4(translation(1, 2, 3), scale(2));
	check('matrix inverse', nearArray(Array.from(I.multiply4(m, I.invert4(m))), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
}

/* ------------------------------------------------------------------------------------------------------------
 * Scene A: WebGL 1, Emscripten style uploads (heap views, reused memory), interleaved normalized attributes
 * ---------------------------------------------------------------------------------------------------------- */

function sceneWebGL1() {
	const gl = document.getElementById('webgl1').getContext('webgl');
	const HEAP = new Uint8Array(1 << 16);
	const heap = new DataView(HEAP.buffer);
	const STRIDE = 20, BASE = 1000;
	for (let i = 0; i < 10; i++) {
		const o = BASE + i * STRIDE;
		heap.setFloat32(o, i, true);
		heap.setFloat32(o + 4, i * 2, true);
		heap.setFloat32(o + 8, -i, true);
		heap.setInt8(o + 12, 0);
		heap.setInt8(o + 13, 0);
		heap.setInt8(o + 14, 127);
		heap.setUint16(o + 16, i % 2 ? 65535 : 0, true);
		heap.setUint16(o + 18, i >= 5 ? 65535 : 0, true);
	}
	const vbo = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
	gl.bufferData(gl.ARRAY_BUFFER, 10 * STRIDE, gl.STATIC_DRAW);
	gl.bufferSubData(gl.ARRAY_BUFFER, 0, HEAP.subarray(BASE, BASE + 5 * STRIDE));
	gl.bufferSubData(gl.ARRAY_BUFFER, 5 * STRIDE, HEAP.subarray(BASE + 5 * STRIDE, BASE + 10 * STRIDE));
	HEAP.fill(0xAB, BASE, BASE + 10 * STRIDE); // the heap is reused immediately

	const indices = new Uint16Array([9, 9, 9, 3, 4, 5, 3, 5, 6]);
	HEAP.set(new Uint8Array(indices.buffer), 3001);
	const ibo = gl.createBuffer();
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, HEAP.subarray(3001, 3001 + indices.byteLength), gl.STATIC_DRAW);
	HEAP.fill(0xCD, 3001, 3001 + indices.byteLength);

	const main = buildProgram(gl,
		`attribute vec3 a_position; attribute vec3 a_normal; attribute vec2 a_texcoord;
		uniform mat4 u_modelMatrix; uniform mat4 u_viewProj; varying vec2 v_uv; varying vec3 v_n;
		void main() { v_uv = a_texcoord; v_n = a_normal; gl_Position = u_viewProj * u_modelMatrix * vec4(a_position, 1.0); }`,
		`precision mediump float; uniform sampler2D u_texture; uniform sampler2D u_lightmap; varying vec2 v_uv; varying vec3 v_n;
		void main() { gl_FragColor = texture2D(u_texture, v_uv) * texture2D(u_lightmap, v_uv) + vec4(v_n * 0.001, 0.0); }`,
		{ a_position: 0, a_normal: 1, a_texcoord: 2 });
	const depth = buildProgram(gl,
		`attribute vec3 a_position; uniform mat4 u_modelMatrix; uniform mat4 u_viewProj;
		void main() { gl_Position = u_viewProj * u_modelMatrix * vec4(a_position, 1.0); }`,
		`precision mediump float; void main() { gl_FragColor = vec4(1.0); }`,
		{ a_position: 0 });

	// 6x4 RGBA texture, texel 7 is fully transparent but still has a color
	const pixels = new Uint8Array(6 * 4 * 4);
	for (let i = 0; i < 24; i++)
		pixels.set([i * 10, 255 - i * 10, (i * 37) & 255, i === 7 ? 0 : 128 + i], i * 4);
	const texture = gl.createTexture();
	gl.activeTexture(gl.TEXTURE3);
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 6, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

	// LUMINANCE is not color-renderable: exercises the draw-based readback, whose temporary
	// NEAREST/CLAMP parameters must be reverted afterwards
	const lightmap = gl.createTexture();
	gl.activeTexture(gl.TEXTURE5);
	gl.bindTexture(gl.TEXTURE_2D, lightmap);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 4, 4, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(16).fill(200));
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);

	const fbo = gl.createFramebuffer();
	const fboTexture = gl.createTexture();
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, fboTexture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTexture, 0);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);

	const uniforms = (program) => ({
		model: gl.getUniformLocation(program, 'u_modelMatrix'),
		viewProj: gl.getUniformLocation(program, 'u_viewProj')
	});
	const mainUniforms = uniforms(main);
	const depthUniforms = uniforms(depth);

	return {
		name: 'webgl1',
		gl,
		texture,
		fboTexture,
		expectedPixels: pixels,
		draw() {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.disable(gl.SCISSOR_TEST);
			gl.disable(gl.BLEND);
			gl.colorMask(true, true, true, true);
			gl.viewport(0, 0, 96, 96);
			gl.clearColor(0.1, 0.1, 0.1, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
			gl.enableVertexAttribArray(0);
			gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
			gl.enableVertexAttribArray(1);
			gl.vertexAttribPointer(1, 3, gl.BYTE, true, STRIDE, 12);
			gl.enableVertexAttribArray(2);
			gl.vertexAttribPointer(2, 2, gl.UNSIGNED_SHORT, true, STRIDE, 16);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);

			gl.useProgram(depth); // depth pre-pass: same geometry, positions only
			gl.uniformMatrix4fv(depthUniforms.viewProj, false, VIEW_PROJECTION);
			gl.uniformMatrix4fv(depthUniforms.model, false, translation(10, 0, 0));
			gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 6);

			gl.useProgram(main);
			gl.uniform1i(gl.getUniformLocation(main, 'u_texture'), 3);
			gl.uniform1i(gl.getUniformLocation(main, 'u_lightmap'), 5);
			gl.uniformMatrix4fv(mainUniforms.viewProj, false, VIEW_PROJECTION);
			gl.uniformMatrix4fv(mainUniforms.model, false, translation(10, 0, 0));
			gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 6);
			gl.uniformMatrix4fv(mainUniforms.model, false, translation(20, 0, 0));
			gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 6);
			gl.drawArrays(gl.LINES, 0, 2); // not exportable

			// Leave unusual state behind; the ripper must not change any of it
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
			gl.pixelStorei(gl.PACK_ALIGNMENT, 8);
			gl.activeTexture(gl.TEXTURE3);
			gl.viewport(1, 2, 3, 4);
			gl.enable(gl.SCISSOR_TEST);
			gl.enable(gl.BLEND);
			gl.colorMask(true, false, true, false);
			gl.bindBuffer(gl.ARRAY_BUFFER, null);
		},
		snapshot() {
			const state = {
				framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING) === fbo,
				packAlignment: gl.getParameter(gl.PACK_ALIGNMENT),
				activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE) - gl.TEXTURE0,
				viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
				scissor: gl.isEnabled(gl.SCISSOR_TEST),
				blend: gl.isEnabled(gl.BLEND),
				depthTest: gl.isEnabled(gl.DEPTH_TEST),
				colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
				program: gl.getParameter(gl.CURRENT_PROGRAM) === main,
				arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
				elementBuffer: gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) === ibo,
				unit3: gl.getParameter(gl.TEXTURE_BINDING_2D) === texture,
				attrib0: [gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_ENABLED), gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_STRIDE),
					gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) === vbo],
				error: gl.getError()
			};
			gl.activeTexture(gl.TEXTURE5);
			state.unit5 = gl.getParameter(gl.TEXTURE_BINDING_2D) === lightmap;
			state.lightmapParams = [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER, gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]
				.map(p => gl.getTexParameter(gl.TEXTURE_2D, p));
			gl.activeTexture(gl.TEXTURE3);
			return JSON.stringify(state);
		}
	};
}

/* ------------------------------------------------------------------------------------------------------------
 * Scene B: WebGL 2, VAO, strips with primitive restart, half floats, packed normals, UBO model matrix,
 * a buffer updated between two draws, float and depth textures
 * ---------------------------------------------------------------------------------------------------------- */

function sceneWebGL2() {
	const gl = document.getElementById('webgl2').getContext('webgl2');
	const vao = gl.createVertexArray();
	gl.bindVertexArray(vao);

	const P = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [2, 0, 0], [3, 0, 0], [2, 1, 0]];
	const positions = new Float32Array(12 + P.length * 3);
	P.forEach((p, i) => positions.set(p, 12 + i * 3));
	const positionBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 48);

	const uvs = new Uint16Array(P.length * 2);
	P.forEach((_, i) => uvs.set([toHalf(i * 0.125), toHalf(0.25)], i * 2));
	const uvBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
	gl.enableVertexAttribArray(1);
	gl.vertexAttribPointer(1, 2, gl.HALF_FLOAT, false, 0, 0);

	const normalBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Uint32Array(P.length).fill(((511 << 20) | (1 << 30)) >>> 0), gl.STATIC_DRAW);
	gl.enableVertexAttribArray(2);
	gl.vertexAttribPointer(2, 4, gl.INT_2_10_10_10_REV, true, 0, 0);

	const indexBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array([0, 1, 2, 3, 0xFFFFFFFF, 4, 5, 6, 4, 5, 6]), gl.STATIC_DRAW);
	gl.bindVertexArray(null);

	const program = buildProgram(gl,
		`#version 300 es
		layout(location = 0) in vec3 position; layout(location = 1) in vec2 uv; layout(location = 2) in vec4 normal;
		layout(std140) uniform Mesh { mat4 world; };
		uniform mat4 viewProjection;
		out vec2 vUV; out vec3 vN;
		void main() { vUV = uv; vN = normal.xyz; gl_Position = viewProjection * world * vec4(position, 1.0); }`,
		`#version 300 es
		precision highp float;
		uniform sampler2D diffuseSampler; uniform sampler2D normalSampler; uniform highp sampler2D shadowSampler;
		in vec2 vUV; in vec3 vN; out vec4 color;
		void main() { color = texture(diffuseSampler, vUV) + texture(normalSampler, vUV) * 0.01 + texture(shadowSampler, vUV) * 0.01 + vec4(vN * 0.001, 0.0); }`);
	gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, 'Mesh'), 2);
	const ubo = gl.createBuffer();
	gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
	gl.bufferData(gl.UNIFORM_BUFFER, 512, gl.DYNAMIC_DRAW);
	gl.bufferSubData(gl.UNIFORM_BUFFER, 256, scale(2));
	gl.bindBuffer(gl.UNIFORM_BUFFER, null);

	const diffusePixels = new Uint8Array(8 * 8 * 4);
	for (let y = 0; y < 8; y++)
		for (let x = 0; x < 8; x++)
			diffusePixels.set([x * 32, y * 32, 255 - x * 16, 255], (y * 8 + x) * 4);
	const diffuse = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, diffuse);
	gl.texStorage2D(gl.TEXTURE_2D, 4, gl.RGBA8, 8, 8);
	gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, diffusePixels);
	gl.generateMipmap(gl.TEXTURE_2D);

	const floatTexture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, floatTexture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 2, 2, 0, gl.RGBA, gl.FLOAT, new Float32Array(16).map((_, i) => [0.25, 0.5, 0.75, 1][i % 4]));
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); // incomplete without a sampler override
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

	const depthTexture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, depthTexture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 4, 4, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

	const readFbo = gl.createFramebuffer();
	const pbo = gl.createBuffer();
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
	gl.bufferData(gl.PIXEL_PACK_BUFFER, 64, gl.STREAM_READ);
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
	const pageSampler = gl.createSampler();
	const viewProjection = gl.getUniformLocation(program, 'viewProjection');

	return {
		name: 'webgl2',
		gl,
		expectedPixels: diffusePixels,
		draw() {
			gl.disable(gl.RASTERIZER_DISCARD);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
			gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
			gl.viewport(0, 0, 96, 96);
			gl.clear(gl.COLOR_BUFFER_BIT);

			gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
			gl.bufferSubData(gl.ARRAY_BUFFER, 48 + 4 * 12, new Float32Array([2, 0, 0]));
			gl.bindVertexArray(vao);
			gl.useProgram(program);
			gl.uniformMatrix4fv(viewProjection, false, VIEW_PROJECTION);
			gl.bindBufferRange(gl.UNIFORM_BUFFER, 2, ubo, 256, 64);
			gl.bindSampler(0, null);
			[diffuse, floatTexture, depthTexture].forEach((t, unit) => {
				gl.activeTexture(gl.TEXTURE0 + unit);
				gl.bindTexture(gl.TEXTURE_2D, t);
			});
			gl.uniform1i(gl.getUniformLocation(program, 'diffuseSampler'), 0);
			gl.uniform1i(gl.getUniformLocation(program, 'normalSampler'), 1);
			gl.uniform1i(gl.getUniformLocation(program, 'shadowSampler'), 2);
			gl.drawElements(gl.TRIANGLE_STRIP, 8, gl.UNSIGNED_INT, 0);
			// the same buffer changes before the next draw call (cached GPU reads must notice)
			gl.bufferSubData(gl.ARRAY_BUFFER, 48 + 4 * 12, new Float32Array([100, 100, 100]));
			gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_INT, 32);
			// instanced draw where the UVs are per-instance data: they must not be exported as per-vertex UVs
			gl.vertexAttribDivisor(1, 1);
			gl.drawElementsInstanced(gl.TRIANGLES, 3, gl.UNSIGNED_INT, 20, 2);
			gl.vertexAttribDivisor(1, 0);

			// Leave unusual state behind
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFbo);
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
			gl.pixelStorei(gl.PACK_ROW_LENGTH, 7);
			gl.bindSampler(0, pageSampler);
			gl.activeTexture(gl.TEXTURE2);
			gl.bindBuffer(gl.COPY_READ_BUFFER, uvBuffer);
			gl.enable(gl.RASTERIZER_DISCARD);
		},
		snapshot() {
			gl.activeTexture(gl.TEXTURE0);
			const unit0 = gl.getParameter(gl.TEXTURE_BINDING_2D) === diffuse;
			const sampler0 = gl.getParameter(gl.SAMPLER_BINDING) === pageSampler;
			gl.activeTexture(gl.TEXTURE2);
			return JSON.stringify({
				readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === readFbo,
				drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
				pixelPack: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) === pbo,
				packRowLength: gl.getParameter(gl.PACK_ROW_LENGTH),
				copyRead: gl.getParameter(gl.COPY_READ_BUFFER_BINDING) === uvBuffer,
				vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) === vao,
				program: gl.getParameter(gl.CURRENT_PROGRAM) === program,
				rasterizerDiscard: gl.isEnabled(gl.RASTERIZER_DISCARD),
				unit0, sampler0,
				floatMinFilter: (gl.bindTexture(gl.TEXTURE_2D, floatTexture), gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER)),
				restore: (gl.bindTexture(gl.TEXTURE_2D, depthTexture), true),
				error: gl.getError()
			});
		}
	};
}

/* ------------------------------------------------------------------------------------------------------------
 * Scene C: Unity (hlslcc) naming, vec4 positions, matrix as a vec4 array, drawArrays with an offset,
 * a compressed texture and an sRGB texture
 * ---------------------------------------------------------------------------------------------------------- */

function sceneUnity() {
	const gl = document.getElementById('unity').getContext('webgl2');
	const data = new Float32Array(6 * 6);
	for (let i = 0; i < 6; i++)
		data.set([i, i + 0.5, 0, 1, i / 8, 1 - i / 8], i * 6);
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

	const program = buildProgram(gl,
		`#version 300 es
		in highp vec4 in_POSITION0; in highp vec2 in_TEXCOORD0;
		uniform vec4 hlslcc_mtx4x4unity_ObjectToWorld[4]; uniform vec4 hlslcc_mtx4x4unity_MatrixVP[4];
		out highp vec2 vs_TEXCOORD0;
		void main() {
			vec4 u = in_POSITION0.yyyy * hlslcc_mtx4x4unity_ObjectToWorld[1];
			u = hlslcc_mtx4x4unity_ObjectToWorld[0] * in_POSITION0.xxxx + u;
			u = hlslcc_mtx4x4unity_ObjectToWorld[2] * in_POSITION0.zzzz + u;
			u = u + hlslcc_mtx4x4unity_ObjectToWorld[3];
			gl_Position = hlslcc_mtx4x4unity_MatrixVP[0] * u.x + hlslcc_mtx4x4unity_MatrixVP[1] * u.y + hlslcc_mtx4x4unity_MatrixVP[3];
			vs_TEXCOORD0 = in_TEXCOORD0;
		}`,
		`#version 300 es
		precision mediump float;
		uniform mediump sampler2D _MainTex; uniform mediump sampler2D _EmissionMap; uniform mediump sampler2D _MetallicGlossMap;
		in highp vec2 vs_TEXCOORD0; layout(location = 0) out mediump vec4 SV_Target0;
		void main() { SV_Target0 = texture(_MainTex, vs_TEXCOORD0) + texture(_EmissionMap, vs_TEXCOORD0) + texture(_MetallicGlossMap, vs_TEXCOORD0); }`,
		{ in_POSITION0: 0, in_TEXCOORD0: 1 });

	const vao = gl.createVertexArray();
	gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
	gl.enableVertexAttribArray(1);
	gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);

	let expectedMain;
	const mainTexture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, mainTexture);
	const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
	if (s3tc) {
		// one DXT1 block, solid red
		gl.compressedTexImage2D(gl.TEXTURE_2D, 0, s3tc.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4, 0, new Uint8Array([0x00, 0xF8, 0x00, 0xF8, 0, 0, 0, 0]));
		expectedMain = [255, 0, 0, 255];
	} else {
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 4, 4, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(16).fill(90));
		expectedMain = [90, 90, 90, 255];
	}
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

	const emission = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, emission);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]));
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

	// 2048x600: read back in two bands (512 rows each); one transparent texel in the last band
	const BIG_W = 2048, BIG_H = 600;
	const bigPixels = new Uint8Array(BIG_W * BIG_H * 4);
	for (let y = 0; y < BIG_H; y++)
		for (let x = 0; x < BIG_W; x++)
			bigPixels.set([x & 255, y & 255, (x * y) & 255, y === BIG_H - 1 && x === 5 ? 7 : 255], (y * BIG_W + x) * 4);
	const big = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, big);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, BIG_W, BIG_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, bigPixels);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

	const objectToWorld = gl.getUniformLocation(program, 'hlslcc_mtx4x4unity_ObjectToWorld');
	const matrixVP = gl.getUniformLocation(program, 'hlslcc_mtx4x4unity_MatrixVP');
	return {
		name: 'unity',
		gl,
		s3tc: !!s3tc,
		expectedMain,
		big: { width: BIG_W, height: BIG_H, pixels: bigPixels },
		draw() {
			gl.viewport(0, 0, 96, 96);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.bindVertexArray(vao);
			gl.useProgram(program);
			gl.uniform4fv(objectToWorld, translation(0, 5, 0));
			gl.uniform4fv(matrixVP, VIEW_PROJECTION);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, mainTexture);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, emission);
			gl.uniform1i(gl.getUniformLocation(program, '_MainTex'), 0);
			gl.uniform1i(gl.getUniformLocation(program, '_EmissionMap'), 1);
			gl.activeTexture(gl.TEXTURE2);
			gl.bindTexture(gl.TEXTURE_2D, big);
			gl.uniform1i(gl.getUniformLocation(program, '_MetallicGlossMap'), 2);
			gl.drawArrays(gl.TRIANGLES, 3, 3);
		},
		snapshot() {
			return JSON.stringify({ vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) === vao, error: gl.getError() });
		}
	};
}

/* ------------------------------------------------------------------------------------------------------------
 * Scene D: a model viewer (like Tripo): the model is drawn without an index buffer and only has modelViewMatrix
 * (the camera can't be found), the frame goes through a post-processing pass, and an axis gizmo is drawn into a
 * small corner viewport
 * ---------------------------------------------------------------------------------------------------------- */

function sceneViewer() {
	const gl = document.getElementById('viewer').getContext('webgl');
	const quad = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, quad);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]), gl.STATIC_DRAW);
	const model = buildProgram(gl,
		`attribute vec3 position; uniform mat4 modelViewMatrix;
		void main() { gl_Position = modelViewMatrix * vec4(position * 0.1, 1.0); }`,
		`precision mediump float; void main() { gl_FragColor = vec4(1.0); }`,
		{ position: 0 });
	const modelView = gl.getUniformLocation(model, 'modelViewMatrix');

	const target = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, target);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.bindTexture(gl.TEXTURE_2D, null);
	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	const triangle = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	const pass = buildProgram(gl,
		`attribute vec2 position; varying vec2 vUv;
		void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`,
		`precision mediump float; uniform sampler2D tDiffuse; varying vec2 vUv;
		void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
		{ position: 0 });

	return {
		name: 'viewer',
		gl,
		draw() {
			// the scene goes into a render target ...
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
			gl.viewport(0, 0, 8, 8);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.useProgram(model);
			gl.bindBuffer(gl.ARRAY_BUFFER, quad);
			gl.enableVertexAttribArray(0);
			gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
			gl.uniformMatrix4fv(modelView, false, translation(0, 0, -5));
			gl.drawArrays(gl.TRIANGLES, 0, 6);
			// ... which a full-screen pass copies to the canvas ...
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, 96, 96);
			gl.useProgram(pass);
			gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
			gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, target);
			gl.uniform1i(gl.getUniformLocation(pass, 'tDiffuse'), 0);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			gl.bindTexture(gl.TEXTURE_2D, null);
			// ... and an axis gizmo is drawn into a corner
			gl.viewport(80, 80, 16, 16);
			gl.useProgram(model);
			gl.bindBuffer(gl.ARRAY_BUFFER, quad);
			gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
			gl.uniformMatrix4fv(modelView, false, translation(2, 0, -5));
			gl.drawArrays(gl.TRIANGLES, 0, 6);
		},
		snapshot() {
			return JSON.stringify({ error: gl.getError() });
		}
	};
}

/* ------------------------------------------------------------------------------------------------------------
 * Scene E: pick mode. A full-screen background and two colored quads; clicking the right one must rip only it.
 * ---------------------------------------------------------------------------------------------------------- */

function scenePick() {
	const gl = document.getElementById('pick').getContext('webgl');
	const background = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, background);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), gl.STATIC_DRAW);
	const quad = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, quad);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.4, -0.4, 0, 0.4, -0.4, 0, 0.4, 0.4, 0, -0.4, -0.4, 0, 0.4, 0.4, 0, -0.4, 0.4, 0]), gl.STATIC_DRAW);
	const program = buildProgram(gl,
		`attribute vec3 position; uniform mat4 modelMatrix; void main() { gl_Position = modelMatrix * vec4(position, 1.0); }`,
		`precision mediump float; uniform vec4 u_color; void main() { gl_FragColor = u_color; }`,
		{ position: 0 });
	const model = gl.getUniformLocation(program, 'modelMatrix');
	const color = gl.getUniformLocation(program, 'u_color');
	const draw = (buffer, matrix, rgba) => {
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		gl.uniformMatrix4fv(model, false, matrix);
		gl.uniform4fv(color, rgba);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	};
	return {
		name: 'pick',
		gl,
		rightColor: [0.9, 0.2, 0.1, 1],
		draw() {
			gl.viewport(0, 0, 96, 96);
			gl.clearColor(0, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.useProgram(program);
			draw(background, translation(0, 0, 0), [0.3, 0.3, 0.3, 1]);
			draw(quad, translation(-0.5, 0, 0), [0.1, 0.4, 0.9, 1]);
			draw(quad, translation(0.5, 0, 0), this.rightColor);
		},
		snapshot() {
			return JSON.stringify({ error: gl.getError() });
		}
	};
}

/* ------------------------------------------------------------------------------------------------------------
 * Output parsing
 * ---------------------------------------------------------------------------------------------------------- */

async function inflate(format, chunks) {
	const stream = new DecompressionStream(format);
	const writer = stream.writable.getWriter();
	const output = new Response(stream.readable).arrayBuffer();
	for (const chunk of chunks)
		await writer.write(chunk);
	await writer.close();
	return new Uint8Array(await output);
}

async function readZip(blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const view = new DataView(bytes.buffer);
	let end = bytes.length - 22;
	while (end >= 0 && view.getUint32(end, true) !== 0x06054B50)
		end--;
	const count = view.getUint16(end + 10, true);
	let p = view.getUint32(end + 16, true);
	const files = {};
	for (let i = 0; i < count; i++) {
		if (view.getUint32(p, true) !== 0x02014B50)
			throw new Error('bad central directory');
		const method = view.getUint16(p + 10, true);
		const crc = view.getUint32(p + 16, true);
		const storedSize = view.getUint32(p + 20, true);
		const size = view.getUint32(p + 24, true);
		const nameLength = view.getUint16(p + 28, true);
		const local = view.getUint32(p + 42, true);
		const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
		p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
		if (view.getUint32(local, true) !== 0x04034B50)
			throw new Error('bad local header for ' + name);
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const stored = bytes.subarray(start, start + storedSize);
		const content = method === 8 ? await inflate('deflate-raw', [stored]) : stored;
		if (content.length !== size || I.crc32([content]) !== crc)
			throw new Error('size/crc mismatch for ' + name);
		files[name] = content;
	}
	return files;
}

async function decodePNG(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let p = 8, width = 0, height = 0, colorType = 0;
	const idat = [];
	while (p < bytes.length) {
		const length = view.getUint32(p);
		const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
		if (I.crc32([bytes.subarray(p + 4, p + 8 + length)]) !== view.getUint32(p + 8 + length))
			throw new Error('PNG chunk CRC mismatch: ' + type);
		if (type === 'IHDR') {
			width = view.getUint32(p + 8);
			height = view.getUint32(p + 12);
			colorType = bytes[p + 17];
		} else if (type === 'IDAT') {
			idat.push(bytes.subarray(p + 8, p + 8 + length));
		}
		p += 12 + length;
	}
	const raw = await inflate('deflate', idat);
	const channels = colorType === 6 ? 4 : 3;
	const rowLength = width * channels;
	const out = new Uint8Array(width * height * 4);
	let previous = new Uint8Array(rowLength);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (rowLength + 1)];
		const row = raw.slice(y * (rowLength + 1) + 1, (y + 1) * (rowLength + 1));
		for (let i = 0; i < rowLength; i++) {
			const a = i >= channels ? row[i - channels] : 0, b = previous[i], c = i >= channels ? previous[i - channels] : 0;
			let predictor = 0;
			if (filter === 1) predictor = a;
			else if (filter === 2) predictor = b;
			else if (filter === 3) predictor = (a + b) >> 1;
			else if (filter === 4) {
				const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
				predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			row[i] = (row[i] + predictor) & 0xFF;
		}
		for (let x = 0; x < width; x++) {
			out[(y * width + x) * 4] = row[x * channels];
			out[(y * width + x) * 4 + 1] = row[x * channels + 1];
			out[(y * width + x) * 4 + 2] = row[x * channels + 2];
			out[(y * width + x) * 4 + 3] = channels === 4 ? row[x * channels + 3] : 255;
		}
		previous = row;
	}
	return { width, height, pixels: out, channels };
}

/* Minimal GLB reader: checks the container and returns the JSON and a reader for accessors. */
function parseGLB(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== 0x46546C67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length)
		throw new Error('bad GLB header');
	const jsonLength = view.getUint32(12, true);
	if (view.getUint32(16, true) !== 0x4E4F534A || jsonLength % 4)
		throw new Error('bad JSON chunk');
	const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
	const binStart = 20 + jsonLength;
	const binLength = view.getUint32(binStart, true);
	if (view.getUint32(binStart + 4, true) !== 0x004E4942 || binStart + 8 + binLength !== bytes.length || binLength !== json.buffers[0].byteLength)
		throw new Error('bad BIN chunk');
	const bin = bytes.subarray(binStart + 8, binStart + 8 + binLength);
	const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
	const ARRAYS = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array };
	const accessor = (index) => {
		const a = json.accessors[index];
		const v = json.bufferViews[a.bufferView];
		const Type = ARRAYS[a.componentType];
		if (v.byteOffset % 4)
			throw new Error('unaligned buffer view');
		return new Type(bin.buffer.slice(bin.byteOffset + v.byteOffset, bin.byteOffset + v.byteOffset + a.count * COMPONENTS[a.type] * Type.BYTES_PER_ELEMENT));
	};
	const image = (index) => {
		const v = json.bufferViews[json.images[index].bufferView];
		return bin.subarray(v.byteOffset, v.byteOffset + v.byteLength);
	};
	return { json, accessor, image };
}

function checkGLB(label, glb) {
	const { json, accessor } = glb;
	let problems = [];
	for (const mesh of json.meshes) {
		for (const primitive of mesh.primitives) {
			const positions = accessor(primitive.attributes.POSITION);
			const info = json.accessors[primitive.attributes.POSITION];
			const count = positions.length / 3;
			for (let k = 0; k < 3; k++) {
				let lo = Infinity, hi = -Infinity;
				for (let i = k; i < positions.length; i += 3) {
					lo = Math.min(lo, positions[i]);
					hi = Math.max(hi, positions[i]);
				}
				if (lo !== info.min[k] || hi !== info.max[k])
					problems.push(`${mesh.name}: POSITION min/max`);
			}
			if (Array.from(accessor(primitive.indices)).some(i => i >= count))
				problems.push(`${mesh.name}: index out of range`);
			if (primitive.attributes.NORMAL !== undefined) {
				const normals = accessor(primitive.attributes.NORMAL);
				for (let i = 0; i < normals.length; i += 3) {
					if (Math.abs(Math.hypot(normals[i], normals[i + 1], normals[i + 2]) - 1) > 1e-3) {
						problems.push(`${mesh.name}: normal not unit length`);
						break;
					}
				}
			}
		}
	}
	for (const [index] of (json.images || []).entries()) {
		const png = glb.image(index);
		if (png[0] !== 0x89 || png[1] !== 0x50)
			problems.push(`image ${index} is not a PNG`);
	}
	check(`${label}: GLB is well-formed (accessors, indices, normals, images)`, problems.length === 0, problems.slice(0, 5));
}

function parseOBJ(text) {
	const v = [], vt = [], vn = [], f = [], objects = [];
	let mtllib = null, usemtl = null;
	for (const line of text.split('\n')) {
		const parts = line.trim().split(/\s+/);
		switch (parts[0]) {
			case 'v': v.push(parts.slice(1).map(Number)); break;
			case 'vt': vt.push(parts.slice(1).map(Number)); break;
			case 'vn': vn.push(parts.slice(1).map(Number)); break;
			case 'f': f.push(parts.slice(1).map(s => s.split('/').map(n => (n ? Number(n) : null)))); break;
			case 'o': objects.push(parts[1]); break;
			case 'mtllib': mtllib = parts[1]; break;
			case 'usemtl': usemtl = parts[1]; break;
		}
	}
	return { v, vt, vn, f, objects, mtllib, usemtl };
}

/* GL rows are bottom-up; with unflip the PNG's first row is the last GL row. */
function flipRows(pixels, width, height) {
	const out = new Uint8Array(pixels.length);
	for (let y = 0; y < height; y++)
		out.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
	return out;
}

/* ------------------------------------------------------------------------------------------------------------
 * Driver
 * ---------------------------------------------------------------------------------------------------------- */

const scenes = [];
let stateMismatches = [];
let lastSnapshots = null;

function frame() {
	if (lastSnapshots) {
		scenes.forEach((scene, i) => {
			const now = scene.snapshot();
			if (now !== lastSnapshots[i])
				stateMismatches.push({ scene: scene.name, before: lastSnapshots[i], after: now });
		});
	}
	for (const scene of scenes)
		scene.draw();
	lastSnapshots = scenes.map(scene => scene.snapshot());
	requestAnimationFrame(frame);
}

function capture(settings) {
	T.downloads.length = 0;
	return new Promise(resolve => {
		const listener = (event) => {
			const message = JSON.parse(event.detail);
			if (message.type === 'state' && ['done', 'error', 'idle'].includes(message.state)) {
				document.removeEventListener('webglripper:ext', listener);
				resolve(message);
			}
		};
		document.addEventListener('webglripper:ext', listener);
		document.dispatchEvent(new CustomEvent('webglripper:page', {
			detail: JSON.stringify({ type: 'capture', settings: { __version: 'test', show_preview: false, center_model: false, ...settings } })
		}));
	});
}

const textOf = (bytes) => new TextDecoder().decode(bytes);

async function zipCaptureTests() {
	const [a, b, c] = scenes;
	const result = await capture({ should_download_zip: true, export_layout: 'both', export_format: 'both', is_debug_mode: true });
	check('zip capture finished', result.state === 'done', result.text);
	check('one download', T.downloads.length === 1 && /^webglripper_.*\.zip$/.test(T.downloads[0].name), T.downloads.map(d => d.name));
	const files = await readZip(T.downloads[0].blob);
	const names = Object.keys(files).sort();
	check('zip is valid (sizes and CRCs verified)', true);
	const isRenderTarget = T.internals.isRenderTarget;
	check('textures read back by the ripper are not taken for render targets (textured quads survive the next rip)',
		isRenderTarget(a.fboTexture) && !isRenderTarget(a.texture));
	const info = JSON.parse(textOf(files['rip-info.json']));
	check('10 meshes exported', info.meshes.length === 10, info.meshes.map(m => m.name));
	check('post-processing pass and corner gizmo skipped as overlays', info.summary.skipped.overlays === 2, info.summary.skipped);
	check('LINES draw reported as unsupported', info.summary.skipped.unsupportedMode >= 1, info.summary.skipped);
	check('5 contexts in one zip', info.contexts.length === 5, info.contexts);
	check('7 textures exported', names.filter(n => n.startsWith('textures/')).length === 7, names);
	check('scene.obj and per-mesh OBJs', !!files['scene.obj'] && names.filter(n => /^mesh_\d+\.obj$/.test(n)).length === 10, names);

	const meshes = info.meshes.map(m => ({ info: m, obj: parseOBJ(textOf(files[`${m.name}.obj`])) }));
	const byContext = (index) => meshes.filter(m => m.info.context === index);
	const contextIndex = (canvasId) => info.contexts.find(ctx => ctx.canvas === `#${canvasId}`).index;

	// Scene A
	const meshesA = byContext(contextIndex('webgl1'));
	check('A: depth pre-pass merged, two placed copies kept', meshesA.length === 2, meshesA.length);
	if (meshesA.length === 2) {
		const [m1, m2] = meshesA;
		const expected = (dx) => [3, 4, 5, 6].map(i => [i + dx, i * 2, -i]);
		check('A: only referenced vertices exported', m1.obj.v.length === 4 && m1.obj.f.length === 2, { v: m1.obj.v.length, f: m1.obj.f.length });
		check('A: positions from reused heap + model matrix', nearArray(m1.obj.v.flat(), expected(10).flat()) && nearArray(m2.obj.v.flat(), expected(20).flat()), m1.obj.v);
		check('A: BYTE normalized normals', m1.obj.vn.every(n => nearArray(n, [0, 0, 1])), m1.obj.vn);
		check('A: UNSIGNED_SHORT normalized UVs', nearArray(m1.obj.vt.flat(), [1, 0, 0, 0, 1, 1, 0, 1]), m1.obj.vt);
		check('A: faces reference v/vt/vn, each value written once (1 shared normal)', m1.obj.vn.length === 1 &&
			m1.obj.f.every(face => face.every(([v, t, n]) => v >= 1 && v <= 4 && t >= 1 && t <= 4 && n === 1)), { vn: m1.obj.vn.length, f: m1.obj.f });
		const textures = m1.info.textures;
		check('A: diffuse + lightmap textures', textures.some(t => t.slot === 'map_Kd' && t.uniform === 'u_texture') &&
			textures.some(t => t.slot === 'extra' && t.uniform === 'u_lightmap'), textures);
		const diffuse = textures.find(t => t.slot === 'map_Kd');
		if (diffuse) {
			const png = await decodePNG(files[diffuse.file]);
			const expectedPixels = flipRows(a.expectedPixels, 6, 4);
			check('A: RGBA texture is byte-exact (incl. color under alpha 0)', png.width === 6 && png.height === 4 && png.channels === 4 &&
				png.pixels.every((value, i) => value === expectedPixels[i]));
		}
		const lightmap = textures.find(t => t.uniform === 'u_lightmap');
		if (lightmap && lightmap.file) {
			const png = await decodePNG(files[lightmap.file]);
			check('A: LUMINANCE texture via draw path', png.width === 4 && png.channels === 3 && png.pixels.every((v, i) => (i % 4 === 3 ? v === 255 : v === 200)), Array.from(png.pixels.slice(0, 8)));
		} else {
			check('A: LUMINANCE texture via draw path', false, lightmap);
		}
	}

	// Scene B
	const meshesB = byContext(contextIndex('webgl2'));
	check('B: three draws captured', meshesB.length === 3, meshesB.length);
	if (meshesB.length === 3) {
		const [strip, second, instanced] = meshesB;
		check('B: per-instance attribute (divisor 1) not exported as UVs', instanced.obj.vt.length === 0 && instanced.obj.v.length === 3 &&
			strip.obj.vt.length === 7, { instanced: instanced.obj.vt.length, strip: strip.obj.vt.length });
		check('B: strip + primitive restart -> 3 triangles / 7 vertices', strip.obj.f.length === 3 && strip.obj.v.length === 7, { f: strip.obj.f.length, v: strip.obj.v.length });
		const expectedStrip = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [2, 0, 0], [3, 0, 0], [2, 1, 0]].map(p => p.map(x => x * 2));
		check('B: UBO model matrix (scale 2) applied', nearArray(strip.obj.v.flat(), expectedStrip.flat()), strip.obj.v);
		check('B: half-float UVs', nearArray(strip.obj.vt.flat(), [0, 1, 2, 3, 4, 5, 6].flatMap(i => [i * 0.125, 0.25])), strip.obj.vt);
		check('B: packed 2_10_10_10 normals', strip.obj.vn.every(n => nearArray(n, [0, 0, 1])), strip.obj.vn);
		check('B: buffer update between draws is seen', nearArray(second.obj.v[0], [200, 200, 200]), second.obj.v);
		const textures = strip.info.textures;
		check('B: shadow sampler excluded', !textures.some(t => t.uniform === 'shadowSampler'), textures);
		const diffuse = textures.find(t => t.slot === 'map_Kd');
		if (diffuse) {
			const png = await decodePNG(files[diffuse.file]);
			const expectedPixels = flipRows(b.expectedPixels, 8, 8);
			check('B: texStorage2D texture is byte-exact', png.width === 8 && png.channels === 3 && png.pixels.every((v, i) => v === expectedPixels[i]));
		} else {
			check('B: diffuse texture exported', false, textures);
		}
		const normal = textures.find(t => t.slot === 'map_Bump');
		if (normal && normal.file) {
			const png = await decodePNG(files[normal.file]);
			const px = Array.from(png.pixels.slice(0, 4));
			check('B: RGBA16F texture via draw path', png.width === 2 && nearArray(px, [64, 128, 191, 255], 1), px);
		} else {
			check('B: RGBA16F texture via draw path', false, textures);
		}
	}

	// Scene C
	const meshesC = byContext(contextIndex('unity'));
	check('C: one mesh', meshesC.length === 1, meshesC.length);
	if (meshesC.length === 1) {
		const m = meshesC[0];
		check('C: drawArrays(first=3) + vec4 positions + hlslcc matrix', nearArray(m.obj.v.flat(), [3, 4, 5].flatMap(i => [i, i + 0.5 + 5, 0])), m.obj.v);
		check('C: UVs', nearArray(m.obj.vt.flat(), [3, 4, 5].flatMap(i => [i / 8, 1 - i / 8])), m.obj.vt);
		const main = m.info.textures.find(t => t.uniform === '_MainTex');
		const emission = m.info.textures.find(t => t.uniform === '_EmissionMap');
		check('C: _MainTex is diffuse, _EmissionMap is emissive', main && main.slot === 'map_Kd' && emission && emission.slot === 'map_Ke', m.info.textures);
		if (main && main.file) {
			const png = await decodePNG(files[main.file]);
			const px = Array.from(png.pixels.slice(0, 4));
			check(`C: ${c.s3tc ? 'DXT1 compressed' : 'LUMINANCE'} texture via draw path`, nearArray(px, c.expectedMain, 1), px);
		}
		const big = m.info.textures.find(t => t.uniform === '_MetallicGlossMap');
		if (big && big.file) {
			const png = await decodePNG(files[big.file]);
			const expectedPixels = flipRows(c.big.pixels, c.big.width, c.big.height);
			check('C: 2048x600 texture read in bands is byte-exact (RGBA kept for one transparent texel)', png.width === c.big.width &&
				png.height === c.big.height && png.channels === 4 && png.pixels.every((v, i) => v === expectedPixels[i]));
		} else {
			check('C: 2048x600 texture read in bands is byte-exact', false, m.info.textures);
		}
		if (emission && emission.file) {
			const png = await decodePNG(files[emission.file]);
			check('C: sRGB texture keeps its stored bytes', nearArray(Array.from(png.pixels.slice(0, 3)), [70, 80, 90], 0), Array.from(png.pixels.slice(0, 4)));
		}
	}

	// Scene D
	const meshesD = byContext(contextIndex('viewer'));
	check('D: only the model is left', meshesD.length === 1, meshesD.map(m => m.info));
	if (meshesD.length === 1) {
		const m = meshesD[0];
		check('D: camera unknown -> mesh keeps its own coordinates', m.info.transform === 'local' &&
			nearArray(m.obj.v.flat(), [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), { transform: m.info.transform, v: m.obj.v });
		check('D: triangles drawn without an index buffer are welded (6 -> 4 vertices)', m.obj.v.length === 4 && m.obj.f.length === 2,
			{ v: m.obj.v.length, f: m.obj.f.length });
	}

	// Combined scene + MTL
	const scene = parseOBJ(textOf(files['scene.obj']));
	const totalVertices = meshes.reduce((n, m) => n + m.obj.v.length, 0);
	check('scene.obj contains every mesh with offset indices', scene.objects.length === 10 && scene.v.length === totalVertices &&
		Math.max(...scene.f.flat().map(([v]) => v)) === totalVertices, { objects: scene.objects.length, v: scene.v.length });
	const mtl = textOf(files['materials.mtl']);
	check('MTL references exported textures', /map_Kd textures\/tex_\d+\.png/.test(mtl) && /map_Bump textures\/tex_\d+\.png/.test(mtl), mtl);
	check('OBJ references the MTL', meshes.every(m => m.obj.mtllib === 'materials.mtl'));

	// The same capture as GLB
	if (!files['model.glb']) {
		check('model.glb in the zip', false, names);
		return;
	}
	const glb = parseGLB(files['model.glb']);
	checkGLB('zip', glb);
	check('GLB: one node and mesh per exported mesh', glb.json.nodes.length === 10 && glb.json.meshes.length === 10, glb.json.nodes.length);
	const gltfMesh = (name) => glb.json.meshes.find(m => m.name === name).primitives[0];
	const quad = gltfMesh(meshesA[0].info.name);
	check('GLB: positions match the OBJ', nearArray(Array.from(glb.accessor(quad.attributes.POSITION)), meshesA[0].obj.v.flat()));
	check('GLB: UVs flipped for the glTF convention', nearArray(Array.from(glb.accessor(quad.attributes.TEXCOORD_0)),
		meshesA[0].obj.vt.flatMap(([u, v]) => [u, 1 - v])));
	const material = (primitive) => glb.json.materials[primitive.material];
	check('GLB: base color texture on the textured quad', material(quad).pbrMetallicRoughness.baseColorTexture !== undefined, material(quad));
	const strip = gltfMesh(meshesB[0].info.name);
	check('GLB: normal map from the WebGL 2 scene', material(strip).normalTexture !== undefined, material(strip));
	const unity = gltfMesh(meshesC[0].info.name);
	check('GLB: emissive texture from _EmissionMap', material(unity).emissiveTexture !== undefined && material(unity).emissiveFactor.every(f => f === 1), material(unity));
	check('GLB: normals computed for meshes drawn without any', unity.attributes.NORMAL !== undefined);
	const pickMeshes = byContext(contextIndex('pick'));
	const colored = pickMeshes.map(m => material(gltfMesh(m.info.name)).pbrMetallicRoughness.baseColorFactor);
	check('GLB: base color from the u_color uniform', colored.some(c => nearArray(c, [0.9, 0.2, 0.1, 1], 1e-6)), colored);
	check('MTL: Kd from the u_color uniform', /Kd 0\.9 0\.2 0\.1/.test(mtl), mtl);
}

async function separateDownloadTests() {
	const result = await capture({ should_download_zip: false, export_layout: 'combined', export_format: 'obj', do_model_view_matrix: false });
	check('separate downloads finished', result.state === 'done', result.text);
	const names = T.downloads.map(d => d.name);
	check('prefixed file names, combined scene only', names.every(n => n.startsWith('webglripper_')) &&
		names.filter(n => n.endsWith('.obj')).length === 1 && names.some(n => n.endsWith('_scene.obj')) && names.some(n => n.endsWith('_materials.mtl')), names);
	const sceneFile = T.downloads.find(d => d.name.endsWith('_scene.obj'));
	const obj = parseOBJ(await sceneFile.blob.text());
	check('model matrix can be disabled', obj.v.length > 0 && nearArray(obj.v[0], [3, 6, -3]), obj.v[0]);
	const mtl = await T.downloads.find(d => d.name.endsWith('_materials.mtl')).blob.text();
	const pngNames = names.filter(n => n.endsWith('.png'));
	check('MTL uses the flat downloaded texture names', pngNames.length > 0 && pngNames.every(n => mtl.includes(n)), mtl);
}

/* Sends a command like bridge.js does and resolves when the engine is done with it. */
function command(type, settings, onState) {
	T.downloads.length = 0;
	return new Promise(resolve => {
		const listener = (event) => {
			const message = JSON.parse(event.detail);
			if (message.type !== 'state')
				return;
			if (onState)
				onState(message);
			if (['done', 'error', 'idle'].includes(message.state)) {
				document.removeEventListener('webglripper:ext', listener);
				resolve(message);
			}
		};
		document.addEventListener('webglripper:ext', listener);
		document.dispatchEvent(new CustomEvent('webglripper:page', {
			detail: JSON.stringify({ type, settings: { __version: 'test', show_preview: false, center_model: false, ...settings } })
		}));
	});
}

async function pickTests() {
	const canvas = document.getElementById('pick');
	let picking = false;
	const done = command('pick', { export_format: 'obj' }, (message) => {
		if (message.state === 'picking')
			picking = true;
	});
	check('pick mode starts', picking);
	const rect = canvas.getBoundingClientRect();
	canvas.dispatchEvent(new PointerEvent('pointerdown', {
		clientX: rect.left + rect.width * 0.75, clientY: rect.top + rect.height * 0.5, bubbles: true, cancelable: true, button: 0
	}));
	const result = await done;
	check('pick capture finished', result.state === 'done', result.text);
	const files = await readZip(T.downloads[0].blob);
	const objs = Object.keys(files).filter(n => n.endsWith('.obj'));
	check('only the clicked object is exported', objs.length === 1, objs);
	if (objs.length === 1) {
		const obj = parseOBJ(textOf(files[objs[0]]));
		const xs = obj.v.map(v => v[0]);
		check('it is the right-hand quad', obj.v.length === 4 && near(Math.min(...xs), 0.1) && near(Math.max(...xs), 0.9), obj.v);
		check('with its color', /Kd 0\.9 0\.2 0\.1/.test(textOf(files['materials.mtl'])), textOf(files['materials.mtl']));
	}
}

async function previewTests() {
	let shown = null;
	T.onPreview = async (data) => {
		shown = data;
		const index = data.meshes.findIndex(m => m.positions.length === 12 && m.color && m.color[0] > 0.8); // the red quad
		return { selected: [index], format: 'glb' };
	};
	const result = await command('capture', { show_preview: true, center_model: true, export_format: 'obj' });
	T.onPreview = null;
	check('preview receives every mesh with geometry', shown && shown.meshes.length === 10 && shown.meshes.every(m => m.positions && m.triangles), shown && shown.meshes.length);
	check('preview capture finished', result.state === 'done', result.text);
	const download = T.downloads[0];
	check('format chosen in the preview wins: one .glb', T.downloads.length === 1 && /\.glb$/.test(download.name), T.downloads.map(d => d.name));
	if (!download || !/\.glb$/.test(download.name))
		return;
	const glb = parseGLB(new Uint8Array(await download.blob.arrayBuffer()));
	checkGLB('preview', glb);
	check('only the chosen mesh', glb.json.meshes.length === 1, glb.json.meshes.map(m => m.name));
	const positions = glb.accessor(glb.json.meshes[0].primitives[0].attributes.POSITION);
	const info = glb.json.accessors[glb.json.meshes[0].primitives[0].attributes.POSITION];
	check('moved to the origin, standing on y = 0', near(info.min[1], 0) && near(info.min[0], -info.max[0]) && near(info.min[2], -info.max[2]),
		{ min: info.min, max: info.max, first: Array.from(positions.slice(0, 3)) });

	// Only base color textures are read before the preview; the other maps of the chosen meshes after it
	const reads = { before: 0, after: 0 };
	let previewOpen = false, textured = 0;
	T.onPreview = async (data) => {
		previewOpen = true;
		textured = data.meshes.filter(m => m.texture).length;
		return { selected: [data.meshes.findIndex(m => m.vertexCount === 7 && m.texture)], format: 'glb' }; // scene B's strip
	};
	const deferred = await command('capture', { show_preview: true }, (message) => {
		const match = /^Reading texture 1 of (\d+)/.exec(message.text || '');
		if (match)
			reads[previewOpen ? 'after' : 'before'] += +match[1];
	});
	T.onPreview = null;
	check('deferred textures: capture finished', deferred.state === 'done', deferred.text);
	check('only base color textures are read before the preview', reads.before > 0 && reads.before < 7 && textured > 0, { reads, textured });
	check('the chosen mesh\'s normal map is read after the preview', reads.after === 1, reads);
	if (T.downloads[0] && /\.glb$/.test(T.downloads[0].name)) {
		const strip = parseGLB(new Uint8Array(await T.downloads[0].blob.arrayBuffer()));
		const material = strip.json.materials[strip.json.meshes[0].primitives[0].material];
		check('GLB of the chosen mesh has its base color and normal map', strip.json.meshes.length === 1 && strip.json.images.length === 2 &&
			material.normalTexture !== undefined && material.pbrMetallicRoughness.baseColorTexture !== undefined, material);
	}
}

async function main() {
	unitTests();
	scenes.push(sceneWebGL1(), sceneWebGL2(), sceneUnity(), sceneViewer(), scenePick());
	document.createElement('canvas').getContext('webgl'); // a detached probe context must not matter
	requestAnimationFrame(frame);
	await new Promise(resolve => setTimeout(resolve, 300));
	stateMismatches = [];

	await zipCaptureTests();
	await new Promise(resolve => setTimeout(resolve, 200));
	check('page GL state untouched by the zip capture', stateMismatches.length === 0, stateMismatches.slice(0, 2));

	stateMismatches = [];
	await separateDownloadTests();
	await new Promise(resolve => setTimeout(resolve, 200));
	check('page GL state untouched by the second capture', stateMismatches.length === 0, stateMismatches.slice(0, 2));

	stateMismatches = [];
	await pickTests();
	await new Promise(resolve => setTimeout(resolve, 200));
	check('page GL state untouched by the pick capture', stateMismatches.length === 0, stateMismatches.slice(0, 2));

	await previewTests();

	const failed = results.filter(r => !r.pass);
	document.getElementById('summary').textContent = `${results.length - failed.length} passed, ${failed.length} failed`;
	document.getElementById('summary').className = failed.length ? 'fail' : 'pass';
	window.testResults = { passed: results.length - failed.length, failed: failed.length, failures: failed };
}

main().catch(err => {
	check('test run crashed', false, String(err && err.stack || err));
	window.testResults = { passed: 0, failed: 1, failures: [{ name: 'crash', detail: String(err && err.stack || err) }] };
});
