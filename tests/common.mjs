// Helpers shared by the Chrome and Firefox test runners.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let failures = 0;
export const failureCount = () => failures;
export function addFailures(count) {
	failures += count;
}

export function report(name, pass, detail) {
	if (!pass)
		failures++;
	const extra = !pass && detail !== undefined ? `  —  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
	console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra}`);
}

export async function poll(fn, timeout, interval = 250) {
	const start = Date.now();
	for (;;) {
		const value = await fn();
		if (value)
			return value;
		if (Date.now() - start > timeout)
			return null;
		await sleep(interval);
	}
}

const MIME = {
	'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
	'.json': 'application/json', '.png': 'image/png'
};

/* Static file server for the repository on 127.0.0.1 (also reachable as "localhost", a different origin). */
export function serve() {
	return new Promise(resolve => {
		const server = http.createServer((req, res) => {
			const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
			if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
			fs.createReadStream(file).pipe(res);
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

/* Minimal ZIP reader that verifies every entry's CRC. */
export function readZip(buffer) {
	let end = buffer.length - 22;
	while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054B50)
		end--;
	if (end < 0)
		throw new Error('no end of central directory');
	const files = {};
	let p = buffer.readUInt32LE(end + 16);
	for (let i = 0, count = buffer.readUInt16LE(end + 10); i < count; i++) {
		const method = buffer.readUInt16LE(p + 10);
		const crc = buffer.readUInt32LE(p + 16);
		const storedSize = buffer.readUInt32LE(p + 20);
		const nameLength = buffer.readUInt16LE(p + 28);
		const local = buffer.readUInt32LE(p + 42);
		const name = buffer.subarray(p + 46, p + 46 + nameLength).toString('utf8');
		p += 46 + nameLength + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
		const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
		const stored = buffer.subarray(start, start + storedSize);
		const content = method === 8 ? zlib.inflateRawSync(stored) : stored;
		if (zlib.crc32(content) !== crc)
			throw new Error(`CRC mismatch in ${name}`);
		files[name] = content;
	}
	return files;
}

/* Checks one zip produced by the end-to-end pages (a textured cube). */
export function checkCubeZip(label, buffer) {
	let files;
	try {
		files = readZip(buffer);
	} catch (err) {
		report(`${label}: valid zip`, false, err.message);
		return;
	}
	const obj = files['mesh_000.obj'] ? files['mesh_000.obj'].toString('utf8') : '';
	const vertices = obj.split('\n').filter(l => l.startsWith('v ')).length;
	const faces = obj.split('\n').filter(l => l.startsWith('f ')).length;
	report(`${label}: cube with 8 positions / 12 faces and its texture`, vertices === 8 && faces === 12 &&
		!!files['textures/tex_000.png'] && !!files['materials.mtl'] && !!files['rip-info.json'] && !!files['model.glb'],
		{ names: Object.keys(files), vertices, faces });
}

/* Expectations for tests/three.html (box with a texture, untextured sphere, ground plane, shadows on). */
export function checkThreeResults(results) {
	report('three.js capture done', results.state === 'done', results.text);
	const near = (a, b, eps = 0.05) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
	const meshes = results.meshes;
	report('four meshes (shadow passes, post-processing and the axis gizmo removed)', meshes.length === 4, meshes);
	report('box in world space at (5, 0, 0)', meshes.some(m => m.vertices === 8 && near(m.center, [5, 0, 0], 0.5) && m.size[1] > 1.9 && m.size[1] < 2.1), meshes);
	report('sphere (modelView only) in world space at (-5, 2, 0)', meshes.some(m => m.faces > 100 && near(m.center, [-5, 2, 0])), meshes);
	report('ground plane at y = -2', meshes.some(m => m.vertices === 4 && near(m.center, [0, -2, 0]) && Math.abs(m.size[0] - 20) < 0.01), meshes);
	report('non-indexed icosahedron welded (540 -> 92 vertices) and placed at (0, 2, -4)',
		meshes.some(m => m.vertices === 92 && m.faces === 180 && near(m.center, [0, 2, -4])), meshes);
	report('box texture in MTL', /map_Kd \S+tex_\d+\.png/.test(results.mtl), results.mtl);
	report('untextured meshes keep their color in MTL (the scene pass, not the shadow pass)',
		(results.mtl.match(/^map_Kd /gm) || []).length === 1 && /^Kd 0\.0\d+ 0\.[34]\d* 0\.2\d*$/m.test(results.mtl), results.mtl);
	report('lit materials take the material color, not the light color (gray ground)', /^Kd 0\.21\d* 0\.21\d* 0\.21\d*$/m.test(results.mtl), results.mtl);
	const glb = results.glb;
	report('GLB loads in three.js GLTFLoader with the same 4 meshes', Array.isArray(glb) && glb.length === 4, glb);
	if (Array.isArray(glb)) {
		report('GLB: textured box at (5, 0, 0), every mesh has normals', glb.some(m => m.map && near(m.center, [5, 0, 0], 0.5)) && glb.every(m => m.normals), glb);
	}
	const pick = results.pick || {};
	report('pick mode through a half-float render target (EffectComposer) finds the gem', pick.state === 'done' && pick.objects === 1 && pick.vertices === 92, pick);
}

/* Expectations for tests/editor.html: an editor-style viewer with a move gizmo, an outline, SMAA, an axis gizmo and a
 * sky sphere. Only the model is exported; the sky is offered in the preview but not selected. */
export function checkEditorResults(results) {
	report('editor viewer capture done', results.state === 'done' && results.direct.state === 'done', results.text);
	const preview = results.preview || [];
	const background = preview.filter(m => m.background);
	report('preview: the model and the sky only (move gizmo, outline, SMAA passes and axis gizmo left out)',
		preview.length === 2 && background.length === 1 && background[0].vertices > 1000, preview);
	report('preview: the sky is marked as background and not selected, the model is selected',
		preview.every(m => m.selected === !m.background), preview);
	const glb = results.glb || [];
	const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.02);
	report('GLB: just the model, in its place at (0.5, 0.3, 0)', glb.length === 1 && near(glb[0].center, [0.5, 0.3, 0]), glb);
	report('without the preview: one OBJ (the background is not downloaded)', results.direct.objs === 1, results.direct);
}

/* Checks the .glb from the pick + preview end-to-end test: just the cube, textured, standing on the origin. */
export function checkPickedCube(label, buffer) {
	try {
		if (buffer.readUInt32LE(0) !== 0x46546C67 || buffer.readUInt32LE(8) !== buffer.length)
			throw new Error('bad GLB header');
		const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString('utf8'));
		const position = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
		const material = json.materials[json.meshes[0].primitives[0].material];
		report(`${label}: one textured cube on the origin`, json.meshes.length === 1 && position.count === 24 &&
			Math.abs(position.min[1]) < 1e-6 && Math.abs(position.min[0] + position.max[0]) < 1e-5 &&
			material.pbrMetallicRoughness.baseColorTexture !== undefined && json.images.length === 1,
			{ meshes: json.meshes.length, position, material });
	} catch (err) {
		report(`${label}: valid GLB`, false, err.message);
	}
}

/* Expectations for tests/heavy.html?grid=300&textures=1&size=4096 exported with layout "both": big enough that OBJ
 * text and PNG data are streamed in many pieces. */
export function checkLargeExport(result, zipBuffer) {
	report('large export finished', result.state === 'done', result.text);
	let files;
	try {
		files = readZip(zipBuffer);
	} catch (err) {
		report('large export: valid zip', false, err.message);
		return;
	}
	const grid = 300;
	const vertices = grid * grid, triangles = (grid - 1) * (grid - 1) * 2;
	const linePattern = /^(#.*|mtllib \S+|o \S+|usemtl \S+|v( -?[\d.e+-]+){3}|vt( -?[\d.e+-]+){2}|vn( -?[\d.e+-]+){3}|f( \d+\/\d+\/\d+){3})$/;
	for (const name of ['mesh_000.obj', 'scene.obj']) {
		const lines = files[name] ? files[name].toString('utf8').split('\n').filter(Boolean) : [];
		const count = (prefix) => lines.filter(l => l.startsWith(prefix)).length;
		const bad = lines.filter(l => !linePattern.test(l));
		report(`large export: ${name} has every vertex and face, no broken lines`, count('v ') === vertices && count('vt ') === vertices &&
			count('vn ') === 1 && count('f ') === triangles && bad.length === 0,
			{ v: count('v '), vt: count('vt '), vn: count('vn '), f: count('f '), bad: bad.slice(0, 3) });
		const first = lines.find(l => l.startsWith('v '));
		report(`large export: ${name} first vertex placed by the model matrix`, first === 'v -4 2 -2', first);
	}
	const png = files['textures/tex_000.png'];
	if (!png) {
		report('large export: 4096x4096 texture present', false, Object.keys(files));
		return;
	}
	let p = 8, idat = [], idatChunks = 0, crcOk = true, width = 0, height = 0, colorType = 0;
	while (p < png.length) {
		const length = png.readUInt32BE(p);
		const type = png.subarray(p + 4, p + 8).toString('latin1');
		crcOk &&= zlib.crc32(png.subarray(p + 4, p + 8 + length)) === png.readUInt32BE(p + 8 + length);
		if (type === 'IHDR') {
			width = png.readUInt32BE(p + 8);
			height = png.readUInt32BE(p + 12);
			colorType = png[p + 17];
		} else if (type === 'IDAT') {
			idat.push(png.subarray(p + 8, p + 8 + length));
			idatChunks++;
		}
		p += 12 + length;
	}
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const channels = colorType === 6 ? 4 : 3;
	report('large export: 4096x4096 PNG is valid', width === 4096 && height === 4096 && crcOk && idatChunks >= 1 &&
		raw.length === (width * channels + 1) * height, { width, height, crcOk, idatChunks, raw: raw.length });
}
