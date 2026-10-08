#!/usr/bin/env node
/*
 * Compares this version of WebGL Ripper with another one (normally the original 0.6) on the scenes in
 * tests/compare/scenes. Both are loaded as real unpacked extensions into a fresh headless Chrome and triggered with a
 * real Insert key press, exactly as a user would.
 *
 *   node tests/compare/compare.mjs --original=<folder of WebGLRipper 0.6>
 *   node tests/compare/compare.mjs --original=<folder> --scenes=three,heavy-late --engines=orig,new
 *
 * Scenes:   overhead-draws, overhead-uploads, draw-calls, three, heap, heap-late, early, heavy, heavy-late
 * Engines:  none (no extension, overhead scenes only), orig, new (dist/chrome, built first), new-glb
 *
 * Measured for every capture: time from the key press to the finished download, the longest frame of the page meanwhile
 * (how long it froze), and on Windows the extra memory of the page's renderer and of the GPU process. The downloads are
 * then opened and checked: how many objects, where they are, which textures at which size. Needs Node.js 22+.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../common.mjs';
import { build } from '../../scripts/build.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCENE_DIR = path.join(ROOT, 'tests', 'compare', 'scenes');
const OUT = path.join(os.tmpdir(), 'webglripper-compare');
const option = (name) => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);

const ORIGINAL = option('original');
const ENGINES = (option('engines') || `none,${ORIGINAL ? 'orig,' : ''}new`).split(',');
const SCENES = [
	{ id: 'overhead-draws', url: 'bench.html?draws=3000&uploads=0', overhead: true },
	{ id: 'overhead-uploads', url: 'bench.html?draws=0&uploads=2000', overhead: true },
	{ id: 'draw-calls', url: 'bench.html?clear=1', timeout: 180000 },
	{ id: 'three', url: 'three.html' },
	{ id: 'heap', url: 'heap.html' },
	{ id: 'heap-late', url: 'heap-late.html' },
	{ id: 'early', url: 'early.html' },
	{ id: 'heavy', url: 'heavy.html?grid=500&textures=2&size=4096', timeout: 180000 },
	{ id: 'heavy-late', url: 'heavy-late.html?grid=500&textures=2&size=4096', timeout: 240000 }
].filter(s => !option('scenes') || option('scenes').split(',').includes(s.id));

// Each extension with settings that make both produce one ZIP of OBJ files: the original with ZIP on, debug logging
// off and the model matrix on (its best settings), this version with the preview off and models kept in place.
const SETTINGS = {
	orig: { default_texture_res: '4096x4096', do_shader_calc: false, is_debug_mode: false, unflip_textures: true, do_model_view_matrix: true, should_download_zip: true, minimum_clears: 1 },
	new: { show_preview: false, export_format: 'obj', center_model: false, should_download_zip: true },
	'new-glb': { show_preview: false, export_format: 'glb', center_model: false }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function findChrome() {
	if (process.env.CHROME)
		return process.env.CHROME;
	const candidates = process.platform === 'win32' ? [
		path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
		'C:/Program Files/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
	] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
		: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
	return candidates.find(p => fs.existsSync(p));
}

/* Private bytes of some processes and the free memory of the system, sampled every ~100 ms (Windows only). */
function memorySampler(pids, onLowMemory) {
	const samples = [];
	if (process.platform !== 'win32')
		return { samples, stop() {} };
	const script = `while ($true) { $parts = foreach ($i in @(${pids.join(',')})) { $p = Get-Process -Id $i -ErrorAction SilentlyContinue; if ($p) { "$i=$($p.PrivateMemorySize64)" } };
		$os = Get-CimInstance Win32_OperatingSystem; [Console]::Out.WriteLine((($parts) -join ' ') + ' free=' + ($os.FreePhysicalMemory * 1024) + ' commit=' + ($os.FreeVirtualMemory * 1024)); Start-Sleep -Milliseconds 100 }`;
	const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
	child.stdout.on('data', (data) => {
		for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
			const sample = Object.fromEntries(line.split(' ').map(pair => pair.split('=')).map(([k, v]) => [k, Number(v)]));
			samples.push(sample);
			// stop before the machine itself runs short of memory
			if ((sample.free && sample.free < 0.6e9) || (sample.commit && sample.commit < 2.5e9))
				onLowMemory(sample);
		}
	});
	return { samples, stop: () => child.kill() };
}

async function runEngine(engine, base) {
	const extension = engine === 'none' ? null : engine === 'orig' ? ORIGINAL : path.join(ROOT, 'dist', 'chrome');
	const downloads = fs.mkdtempSync(path.join(OUT, `downloads-${engine}-`));
	const child = spawn(findChrome(), [
		`--user-data-dir=${fs.mkdtempSync(path.join(OUT, `profile-${engine}-`))}`, '--remote-debugging-pipe',
		'--enable-unsafe-extension-debugging', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check',
		'--headless=new', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
	let nextId = 0, buffered = Buffer.alloc(0);
	const pending = new Map(), listeners = new Set();
	child.stdio[4].on('data', (chunk) => {
		buffered = Buffer.concat([buffered, chunk]);
		let end;
		while ((end = buffered.indexOf(0)) >= 0) {
			const message = JSON.parse(buffered.subarray(0, end));
			buffered = buffered.subarray(end + 1);
			if (message.id) pending.get(message.id)?.(message);
			else listeners.forEach(listener => listener(message));
		}
	});
	// A page busy in a long task doesn't answer; give up on a call after 30 s instead of waiting forever
	const send = (method, params = {}, sessionId) => Promise.race([
		new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0'); }),
		sleep(30000).then(() => ({ timedOut: true }))
	]);
	const evaluate = async (sessionId, expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
	const open = async (url) => {
		const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
		const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
		await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false }, sessionId);
		await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
		await send('Page.navigate', { url }, sessionId);
		return { targetId, sessionId };
	};

	if (extension) {
		const loaded = await send('Extensions.loadUnpacked', { path: extension });
		const id = loaded.result && loaded.result.id;
		if (!id)
			throw new Error(`could not load ${extension}: ${JSON.stringify(loaded.error || loaded)}`);
		const page = await open(`chrome-extension://${id}/options.html`);
		await sleep(800);
		await evaluate(page.sessionId, `new Promise(r => chrome.storage.sync.set(${JSON.stringify(SETTINGS[engine])}, r))`);
		await send('Target.closeTarget', { targetId: page.targetId });
	}
	await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
	const files = new Map();
	listeners.add((message) => {
		if (message.method === 'Browser.downloadWillBegin')
			files.set(message.params.guid, { name: message.params.suggestedFilename });
		if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed') {
			const file = files.get(message.params.guid);
			if (file)
				Object.assign(file, { done: Date.now(), size: message.params.totalBytes, path: path.join(downloads, message.params.guid) });
		}
	});

	const results = {};
	for (const scene of SCENES) {
		if (!extension && !scene.overhead)
			continue;
		files.clear();
		const page = await open(`${base}/${scene.url}`);
		let ready = false;
		for (let i = 0; i < 240 && !ready; i++) {
			await sleep(250);
			ready = await evaluate(page.sessionId, scene.overhead ? '!!window.benchResult' : '!!(window.sceneReady || window.benchResult)');
		}
		if (scene.overhead) {
			const bench = await evaluate(page.sessionId, 'window.benchResult');
			results[scene.id] = { frameMs: bench && bench.mean, hooked: await evaluate(page.sessionId, 'window.RIPPERS ? window.RIPPERS.length > 0 : null') };
			console.log(`  ${engine} ${scene.id}: ${JSON.stringify(results[scene.id])}`);
			await send('Target.closeTarget', { targetId: page.targetId });
			continue;
		}
		await sleep(1500);
		await evaluate(page.sessionId, `window.__gap = 0; (function () { let last = performance.now(); (function tick() { const now = performance.now(); window.__gap = Math.max(window.__gap, now - last); last = now; requestAnimationFrame(tick); })(); })()`);
		const { result: { processInfo } } = await send('SystemInfo.getProcessInfo');
		const gpu = new Set(processInfo.filter(p => p.type !== 'renderer').map(p => String(p.id)));
		let aborted = false;
		const sampler = memorySampler(processInfo.filter(p => p.type === 'renderer' || /gpu/i.test(p.type)).map(p => p.id), (sample) => {
			if (aborted)
				return;
			aborted = true;
			console.log(`  !! the system is short of memory (${Math.round(sample.free / 1e6)} MB free), stopping ${engine}`);
			child.kill();
		});
		await sleep(700);
		const baseline = { ...sampler.samples[sampler.samples.length - 1] };
		const start = Date.now();
		for (const type of ['rawKeyDown', 'keyUp'])
			await send('Input.dispatchKeyEvent', { type, key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45, nativeVirtualKeyCode: 45 }, page.sessionId);
		let lastDone = 0;
		while (Date.now() - start < (scene.timeout || 90000) && !aborted) {
			await sleep(200);
			const all = [...files.values()];
			if (all.length && all.every(f => f.done)) {
				lastDone = Math.max(...all.map(f => f.done));
				if (Date.now() - lastDone > 3000)
					break;
			}
		}
		const longestFrame = aborted ? null : await evaluate(page.sessionId, 'Math.round(window.__gap)');
		sampler.stop();
		const peak = {};
		for (const sample of sampler.samples) {
			for (const [key, value] of Object.entries(sample)) {
				if (key !== 'free' && key !== 'commit')
					peak[key] = Math.max(peak[key] || 0, value);
			}
		}
		const extra = (keys) => Math.round(Math.max(0, ...keys.map(k => peak[k] - (baseline[k] || peak[k]))) / 1048576);
		results[scene.id] = {
			files: [...files.values()].map(f => ({ name: f.name, size: f.size, path: f.path })),
			ms: lastDone ? lastDone - start : null,
			longestFrameMs: longestFrame === undefined ? 'no answer' : longestFrame,
			extraMemoryMB: extra(Object.keys(peak).filter(k => !gpu.has(k))),
			extraGpuMemoryMB: extra(Object.keys(peak).filter(k => gpu.has(k))),
			aborted
		};
		results[scene.id].check = inspect(results[scene.id].files);
		console.log(`  ${engine} ${scene.id}: ${summary(results[scene.id])}`);
		if (aborted)
			break;
		await send('Target.closeTarget', { targetId: page.targetId });
		await sleep(500);
	}
	child.kill();
	return results;
}

/* Opens the downloads: objects with their vertex count and center, textures with their size. */
function inspect(files) {
	const objects = [], textures = [];
	let bytes = 0;
	for (const file of files) {
		if (!file.path || !fs.existsSync(file.path))
			continue;
		const data = fs.readFileSync(file.path);
		bytes += data.length;
		const entries = file.name.endsWith('.zip') ? readZip(data) : { [file.name]: data };
		for (const [name, content] of Object.entries(entries)) {
			if (name.endsWith('.png') && content.readUInt32BE(12) === 0x49484452)
				textures.push(`${content.readUInt32BE(16)}x${content.readUInt32BE(20)}`);
			if (name.endsWith('.obj') && !name.endsWith('scene.obj'))
				objects.push(...objectsOf(content.toString('utf8')));
			if (name.endsWith('.glb'))
				objects.push(...objectsOfGLB(content, textures));
		}
	}
	return { objects, textures, bytes };
}

function objectsOf(text) {
	const positions = [], objects = [];
	let current = null, normals = 0;
	for (const line of text.split('\n')) {
		if (line.startsWith('v '))
			positions.push(line.split(/\s+/).slice(1, 4).map(Number));
		else if (line.startsWith('vn '))
			normals++;
		else if (line.startsWith('f ')) {
			if (!current)
				objects.push(current = { used: new Set() });
			for (const corner of line.split(/\s+/).slice(1))
				if (corner) current.used.add(Number(corner.split('/')[0]));
		} else if (line.startsWith('o ') || line.startsWith('g '))
			current = null;
	}
	return objects.map(object => {
		const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		for (const index of object.used) {
			const p = positions[index - 1];
			if (!p) continue;
			for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
		}
		return { vertices: object.used.size, normals: normals > 0, center: lo.map((l, k) => round((l + hi[k]) / 2)) };
	});
}

function objectsOfGLB(data, textures) {
	const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
	for (const image of json.images || []) textures.push('embedded');
	return json.meshes.map(mesh => {
		const accessor = json.accessors[mesh.primitives[0].attributes.POSITION];
		return { vertices: accessor.count, normals: mesh.primitives[0].attributes.NORMAL !== undefined,
			center: accessor.min.map((min, k) => round((min + accessor.max[k]) / 2)) };
	});
}

const round = (value) => Math.abs(value) > 1e6 ? Number(value.toExponential(2)) : Math.round(value * 100) / 100;

function summary(r) {
	if (r.aborted)
		return 'stopped: the system ran short of memory';
	const c = r.check;
	const place = c.objects.slice(0, 4).map(o => `${o.vertices}v@${o.center.join(',')}`).join(' ');
	return `${r.ms === null ? 'NO FILE' : `${(r.ms / 1000).toFixed(2)} s`}, longest frame ${r.longestFrameMs} ms, +${r.extraMemoryMB} MB (+${r.extraGpuMemoryMB} MB GPU), ` +
		`${(c.bytes / 1048576).toFixed(2)} MB, ${c.objects.length} object(s)${place ? ` [${place}${c.objects.length > 4 ? ' …' : ''}]` : ''}, textures ${c.textures.slice(0, 4).join(' ') || 'none'}`;
}

async function main() {
	if (!findChrome()) {
		console.error('Chrome not found. Set the CHROME environment variable.');
		process.exit(2);
	}
	if (ENGINES.includes('orig') && !(ORIGINAL && fs.existsSync(path.join(ORIGINAL, 'manifest.json')))) {
		console.error('Pass --original=<folder of the other version> (the one with its manifest.json).');
		process.exit(2);
	}
	fs.mkdirSync(OUT, { recursive: true });
	if (ENGINES.some(e => e.startsWith('new')))
		await build();
	const server = http.createServer((req, res) => {
		const file = path.join(SCENE_DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
		if (!file.startsWith(SCENE_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404);
			return res.end();
		}
		res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
		fs.createReadStream(file).pipe(res);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const results = {};
	for (const engine of ENGINES) {
		console.log(`\n== ${engine} ==`);
		results[engine] = await runEngine(engine, `http://127.0.0.1:${server.address().port}`);
	}
	fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
	console.log(`\nResults and downloads: ${OUT}`);
	server.close();
	process.exit(0);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
