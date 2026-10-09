#!/usr/bin/env node
/*
 * Runs the WebGL Ripper tests in Firefox through WebDriver BiDi (no dependencies).
 *
 *   node tests/run-firefox.mjs              engine tests, three.js test and the extension end-to-end test
 *   node tests/run-firefox.mjs --headful    same, with a visible browser window
 *   node tests/run-firefox.mjs --no-three   skip the three.js test (it loads three.js from a CDN)
 *
 * Set FIREFOX=<path to firefox.exe> if Firefox is not found automatically. Firefox 133 or newer is required.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { addFailures, checkEditorResults, checkOptimizedResults, checkSkinnedResults, checkLargeExport, checkPickedCube, checkThreeResults, failureCount, poll, report, serve, sleep } from './common.mjs';
import { build } from '../scripts/build.mjs';

const HEADFUL = process.argv.includes('--headful');
const SKIP_THREE = process.argv.includes('--no-three');
const ADDON_ID = 'rilshrink@webglripper';

function findFirefox() {
	if (process.env.FIREFOX)
		return process.env.FIREFOX;
	const candidates = process.platform === 'win32' ? [
		'C:/Program Files/Mozilla Firefox/firefox.exe',
		'C:/Program Files (x86)/Mozilla Firefox/firefox.exe'
	] : process.platform === 'darwin' ? [
		'/Applications/Firefox.app/Contents/MacOS/firefox'
	] : ['/usr/bin/firefox'];
	return candidates.find(p => fs.existsSync(p));
}

function freePort() {
	return new Promise(resolve => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

class BiDi {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 0;
		this.pending = new Map();
		this.listeners = new Set();
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined && this.pending.has(message.id)) {
				const { resolve, reject, method } = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (message.type === 'error')
					reject(new Error(`${method}: ${message.error} ${message.message}`));
				else
					resolve(message.result);
			} else if (message.type === 'event') {
				for (const listener of this.listeners)
					listener(message);
			}
		});
	}

	static async connect(port) {
		const socket = await poll(() => new Promise(resolve => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
			ws.addEventListener('open', () => resolve(ws));
			ws.addEventListener('error', () => resolve(null));
		}), 30000, 300);
		if (!socket)
			throw new Error('Could not connect to Firefox (WebDriver BiDi)');
		return new BiDi(socket);
	}

	send(method, params = {}) {
		const id = ++this.nextId;
		this.socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
	}

	on(listener) {
		this.listeners.add(listener);
	}
}

const errorsByContext = new Map();

async function openTab(bidi, url) {
	const { context } = await bidi.send('browsingContext.create', { type: 'tab' });
	errorsByContext.set(context, []);
	await bidi.send('browsingContext.navigate', { context, url, wait: 'complete' });
	return { context, errors: errorsByContext.get(context) };
}

/* Evaluates in the page's own realm and returns plain JSON data. */
async function evaluate(bidi, context, expression) {
	const response = await bidi.send('script.evaluate', {
		expression: `(async () => JSON.stringify(await (${expression})))()`,
		target: { context },
		awaitPromise: true,
		resultOwnership: 'none'
	});
	if (response.type === 'exception')
		throw new Error(response.exceptionDetails.text);
	const value = response.result.value;
	return value === undefined ? undefined : JSON.parse(value);
}

async function engineTests(bidi, base) {
	console.log('\n== Engine tests (tests/engine.html) ==');
	const tab = await openTab(bidi, `${base}/tests/engine.html`);
	const results = await poll(() => evaluate(bidi, tab.context, 'window.testResults || null'), 60000);
	if (!results) {
		report('engine tests finished', false, tab.errors);
		return;
	}
	const lines = await evaluate(bidi, tab.context, `Array.from(document.querySelectorAll('#log div')).map(d => d.textContent)`);
	for (const line of lines)
		console.log(line);
	addFailures(results.failed);
	report('no uncaught page errors', tab.errors.length === 0, tab.errors);
	await bidi.send('browsingContext.close', { context: tab.context });
}

async function largeExportTest(bidi, base) {
	console.log('\n== Large export (tests/heavy.html: 90k vertices, 4096x4096 texture) ==');
	const tab = await openTab(bidi, `${base}/tests/heavy.html?grid=300&textures=1&size=4096`);
	await poll(() => evaluate(bidi, tab.context, 'window.ready === true'), 30000);
	await sleep(500);
	const result = await evaluate(bidi, tab.context, `runCapture({ export_layout: 'both', export_format: 'obj', show_preview: false, center_model: false })`);
	const zip = result.state === 'done' ? Buffer.from(await evaluate(bidi, tab.context, 'downloadBase64(0)'), 'base64') : Buffer.alloc(0);
	checkLargeExport(result, zip);
	report('no uncaught page errors', tab.errors.length === 0, tab.errors);
	await bidi.send('browsingContext.close', { context: tab.context });
}

async function threeTests(bidi, base) {
	console.log('\n== three.js test (tests/three.html) ==');
	const tab = await openTab(bidi, `${base}/tests/three.html`);
	const results = await poll(() => evaluate(bidi, tab.context, 'window.testResults || null'), 30000);
	if (!results) {
		report('three.js capture finished (needs network access to cdn.jsdelivr.net)', false, tab.errors);
		return;
	}
	checkThreeResults(results);
	report('no uncaught page errors', tab.errors.length === 0, tab.errors);
	await bidi.send('browsingContext.close', { context: tab.context });

	console.log('\n== Editor-style viewer (tests/editor.html) ==');
	const editor = await openTab(bidi, `${base}/tests/editor.html`);
	const editorResults = await poll(() => evaluate(bidi, editor.context, 'window.testResults || null'), 30000);
	if (!editorResults) {
		report('editor viewer capture finished', false, editor.errors);
		return;
	}
	checkEditorResults(editorResults);
	report('no uncaught page errors', editor.errors.length === 0, editor.errors);
	await bidi.send('browsingContext.close', { context: editor.context });

	console.log('\n== Posed characters (tests/skinned.html) ==');
	const skinned = await openTab(bidi, `${base}/tests/skinned.html`);
	const skinnedResults = await poll(() => evaluate(bidi, skinned.context, 'window.testResults || null'), 30000);
	if (!skinnedResults) {
		report('posed characters capture finished', false, skinned.errors);
		return;
	}
	checkSkinnedResults(skinnedResults);
	report('no uncaught page errors', skinned.errors.length === 0, skinned.errors);
	await bidi.send('browsingContext.close', { context: skinned.context });

	console.log('\n== Optimized glTF model (tests/optimized.html) ==');
	const optimized = await openTab(bidi, `${base}/tests/optimized.html`);
	const optimizedResults = await poll(() => evaluate(bidi, optimized.context, 'window.testResults || null'), 30000);
	if (!optimizedResults) {
		report('optimized model capture finished', false, optimized.errors);
		return;
	}
	checkOptimizedResults(optimizedResults);
	report('no uncaught page errors', optimized.errors.length === 0, optimized.errors);
	await bidi.send('browsingContext.close', { context: optimized.context });
}

async function extensionTests(bidi, base, downloadDir) {
	console.log('\n== Extension end-to-end (dist/webglripper-*-firefox.zip as a temporary add-on) ==');
	try {
		const { firefox } = build({ quiet: true });
		const { extension } = await bidi.send('webExtension.install', { extensionData: { type: 'archivePath', path: firefox.zip } });
		report('extension installs', extension === ADDON_ID, extension);
	} catch (err) {
		report('extension installs', false, err.message);
		return;
	}

	const glbFiles = () => fs.readdirSync(downloadDir).filter(n => n.endsWith('.glb'));
	const settled = () => !fs.readdirSync(downloadDir).some(n => n.endsWith('.part'));

	// Default settings: Insert opens the preview in every frame with WebGL, Enter downloads a .glb
	const tab = await openTab(bidi, `${base}/tests/e2e.html`);
	const engine = await poll(() => evaluate(bidi, tab.context, `!!window[Symbol.for('webglripper.engine')]`), 10000);
	report('engine injected into the page (MAIN world, document_start)', !!engine);
	await sleep(1500);
	const { contexts: tree } = await bidi.send('browsingContext.getTree', { root: tab.context });
	const frames = [tab.context, ...(tree[0].children || []).map(child => child.context)];
	for (const frame of frames)
		await evaluate(bidi, frame, `(window.__states = [], document.addEventListener('webglripper:ext', (e) => { const m = JSON.parse(e.detail); if (m.type === 'state') window.__states.push(m.state); }), true)`);

	await bidi.send('input.performActions', {
		context: tab.context,
		actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE016' }, { type: 'keyUp', value: '\uE016' }] }]
	});
	const previews = await poll(async () => {
		for (const frame of frames) {
			if (!await evaluate(bidi, frame, `window.__states.includes('preview')`))
				return false;
		}
		return true;
	}, 30000);
	report('Insert key opens the preview in the top frame and the cross-origin iframe', !!previews && frames.length === 2, frames.length);
	for (const frame of frames)
		await evaluate(bidi, frame, `(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true)`);
	const firstGlbs = await poll(() => (glbFiles().length >= 2 && settled() ? glbFiles() : null), 30000);
	report('Enter in each preview downloads a .glb', !!firstGlbs, fs.readdirSync(downloadDir));
	if (firstGlbs) {
		await sleep(500);
		for (const name of firstGlbs)
			checkPickedCube(name, fs.readFileSync(path.join(downloadDir, name)));
	}
	report('no page errors during the rip', tab.errors.length === 0, tab.errors);

	// Pick mode with real keyboard and pointer input
	const single = await openTab(bidi, `${base}/tests/e2e-frame.html`);
	await poll(() => evaluate(bidi, single.context, `!!window[Symbol.for('webglripper.engine')]`), 10000);
	await evaluate(bidi, single.context, `(window.__states = [], document.addEventListener('webglripper:ext', (e) => { const m = JSON.parse(e.detail); if (m.type === 'state') window.__states.push(m.state); }), true)`);
	await sleep(1000);
	await bidi.send('input.performActions', {
		context: single.context,
		actions: [{ type: 'key', id: 'keyboard', actions: [
			{ type: 'keyDown', value: '\uE008' }, { type: 'keyDown', value: '\uE016' },
			{ type: 'keyUp', value: '\uE016' }, { type: 'keyUp', value: '\uE008' }] }]
	});
	report('Shift+Insert enters pick mode', !!await poll(() => evaluate(bidi, single.context, `window.__states.includes('picking')`), 5000));
	const center = await evaluate(bidi, single.context, `(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
	await bidi.send('input.performActions', {
		context: single.context,
		actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
			{ type: 'pointerMove', x: center.x, y: center.y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }]
	});
	const preview = await poll(() => evaluate(bidi, single.context, `window.__states.includes('preview')`), 15000);
	report('clicking the cube opens the preview', !!preview, await evaluate(bidi, single.context, 'window.__states'));
	if (preview) {
		const count = glbFiles().length;
		await evaluate(bidi, single.context, `(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true)`);
		const picked = await poll(() => (glbFiles().length > count && settled() ? glbFiles().filter(n => !firstGlbs || !firstGlbs.includes(n)) : null), 20000);
		report('Enter in the preview downloads a .glb', !!picked && picked.length === 1,
			{ files: fs.readdirSync(downloadDir), states: await evaluate(bidi, single.context, 'window.__states'), errors: single.errors });
		if (picked && picked.length === 1) {
			await sleep(300);
			checkPickedCube(picked[0], fs.readFileSync(path.join(downloadDir, picked[0])));
		}
	}
	report('no page errors in pick mode and the preview', single.errors.length === 0, single.errors);

	// WebDriver BiDi can't open moz-extension:// pages; the options page and popup are covered by run-chrome.mjs.
}

async function main() {
	const firefox = findFirefox();
	if (!firefox) {
		console.error('Firefox not found. Set the FIREFOX environment variable.');
		process.exit(2);
	}
	const server = await serve();
	const base = `http://127.0.0.1:${server.address().port}`;
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webglripper-ff-profile-'));
	const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webglripper-ff-downloads-'));
	const prefs = {
		'browser.download.folderList': 2,
		'browser.download.dir': downloadDir,
		'browser.download.useDownloadDir': true,
		'browser.download.always_ask_before_handling_new_types': false,
		'browser.download.alwaysOpenPanel': false,
		'browser.helperApps.neverAsk.saveToDisk': 'application/zip,model/gltf-binary,application/octet-stream',
		'browser.shell.checkDefaultBrowser': false,
		'browser.aboutwelcome.enabled': false,
		'datareporting.policy.dataSubmissionEnabled': false,
		'toolkit.telemetry.reportingpolicy.firstRun': false,
		'webgl.force-enabled': true
	};
	fs.writeFileSync(path.join(profile, 'user.js'),
		Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));

	const port = await freePort();
	const child = spawn(firefox, ['-profile', profile, '-no-remote', '--remote-debugging-port', String(port), ...(HEADFUL ? [] : ['-headless']), 'about:blank'],
		{ stdio: 'ignore' });
	let bidi;
	try {
		bidi = await BiDi.connect(port);
		const session = await bidi.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
		console.log(`Using ${session.capabilities.browserName} ${session.capabilities.browserVersion}`);
		bidi.on(message => {
			if (message.method === 'log.entryAdded' && message.params.level === 'error') {
				const errors = errorsByContext.get(message.params.source.context);
				if (errors)
					errors.push(message.params.text);
			}
		});
		await bidi.send('session.subscribe', { events: ['log.entryAdded'] });
		await engineTests(bidi, base);
		await largeExportTest(bidi, base);
		if (!SKIP_THREE)
			await threeTests(bidi, base);
		await extensionTests(bidi, base, downloadDir);
	} catch (err) {
		report('test runner', false, err.stack || String(err));
	} finally {
		if (bidi)
			await Promise.race([bidi.send('browser.close').catch(() => {}), sleep(3000)]);
		child.kill();
		server.close();
	}
	console.log(failureCount() ? `\n${failureCount()} failure(s)` : '\nAll tests passed');
	process.exit(failureCount() ? 1 : 0);
}

main();
