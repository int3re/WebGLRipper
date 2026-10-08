/* A minimal textured cube rendered every animation frame, used by the end-to-end test pages. */
function spinningCube(canvas, api) {
	'use strict';
	const gl = canvas.getContext(api);
	const faces = [
		[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
		[[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
		[[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]]
	];
	const data = [];
	const indices = [];
	faces.forEach(([n, u, v], face) => {
		for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
			const p = n.map((c, i) => c + u[i] * s + v[i] * t);
			data.push(...p, ...n, (s + 1) / 2, (t + 1) / 2);
		}
		const b = face * 4;
		indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
	});

	const vbo = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
	const ibo = gl.createBuffer();
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

	const compile = (type, source) => {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		return shader;
	};
	const program = gl.createProgram();
	gl.attachShader(program, compile(gl.VERTEX_SHADER,
		`attribute vec3 position; attribute vec3 normal; attribute vec2 uv;
		uniform mat4 modelMatrix; uniform float aspect; varying vec2 vUv; varying float light;
		void main() {
			vUv = uv;
			light = 0.5 + 0.5 * max(dot((modelMatrix * vec4(normal, 0.0)).xyz, normalize(vec3(0.3, 0.5, 1.0))), 0.0);
			vec4 p = modelMatrix * vec4(position, 1.0);
			gl_Position = vec4(p.xy * 0.4, p.z * 0.1, 1.0);
		}`));
	gl.attachShader(program, compile(gl.FRAGMENT_SHADER,
		`precision mediump float; uniform sampler2D map; varying vec2 vUv; varying float light;
		void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb * light, 1.0); }`));
	gl.bindAttribLocation(program, 0, 'position');
	gl.linkProgram(program);

	const size = 16;
	const pixels = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++)
			pixels.set((x >> 2 ^ y >> 2) & 1 ? [230, 120, 30, 255] : [30, 90, 200, 255], (y * size + x) * 4);
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

	const locations = ['position', 'normal', 'uv'].map(name => gl.getAttribLocation(program, name));
	const modelMatrix = gl.getUniformLocation(program, 'modelMatrix');
	gl.enable(gl.DEPTH_TEST);

	function frame(time) {
		const a = time / 1000;
		const c = Math.cos(a), s = Math.sin(a);
		gl.viewport(0, 0, canvas.width, canvas.height);
		gl.clearColor(0.08, 0.08, 0.1, 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.useProgram(program);
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		locations.forEach((location, i) => {
			gl.enableVertexAttribArray(location);
			gl.vertexAttribPointer(location, i === 2 ? 2 : 3, gl.FLOAT, false, 32, [0, 12, 24][i]);
		});
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.uniform1i(gl.getUniformLocation(program, 'map'), 0);
		gl.uniformMatrix4fv(modelMatrix, false, new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]));
		gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
		requestAnimationFrame(frame);
	}
	requestAnimationFrame(frame);
}
