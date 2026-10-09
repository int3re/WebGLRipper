#!/usr/bin/env node
/*
 * Tests the Blender add-on (blender/webglripper_blender.py) with real rips:
 * tests/demo.html is ripped as GLB, STL and USDZ in headless Chrome, then Blender imports them through the add-on.
 *
 *   node tests/run-blender.mjs
 *
 * Set BLENDER=<path to blender.exe> and CHROME=<path to chrome.exe> if they are not found automatically.
 * The add-on is installed into a temporary folder, your Blender configuration is not touched.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, poll, report, failureCount, serve } from './common.mjs';

function findBlender() {
	if (process.env.BLENDER)
		return process.env.BLENDER;
	const roots = process.platform === 'win32'
		? ['C:/Program Files/Blender Foundation', 'D:/Blender', 'C:/Blender']
		: process.platform === 'darwin' ? ['/Applications/Blender.app/Contents/MacOS'] : ['/usr/bin', '/snap/bin'];
	for (const root of roots) {
		if (!fs.existsSync(root))
			continue;
		const direct = path.join(root, process.platform === 'win32' ? 'blender.exe' : 'blender');
		if (fs.existsSync(direct))
			return direct;
		const versions = fs.readdirSync(root).sort().reverse();
		for (const version of versions) {
			const candidate = path.join(root, version, process.platform === 'win32' ? 'blender.exe' : 'blender');
			if (fs.existsSync(candidate))
				return candidate;
		}
	}
	return null;
}

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

/* Rips tests/demo.html with the engine's test hook (no extension needed) and writes plain.glb, stl.stl, usdz.usdz. */
async function ripSamples(chrome, folder) {
	const server = await serve();
	const child = spawn(chrome, [`--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'webglripper-blender-'))}`, '--remote-debugging-pipe',
		'--enable-unsafe-swiftshader', '--headless=new', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
	let id = 0;
	const pending = new Map();
	let buffered = Buffer.alloc(0);
	child.stdio[4].on('data', (chunk) => {
		buffered = Buffer.concat([buffered, chunk]);
		let end;
		while ((end = buffered.indexOf(0)) >= 0) {
			const message = JSON.parse(buffered.subarray(0, end).toString('utf8'));
			buffered = buffered.subarray(end + 1);
			if (message.id && pending.has(message.id))
				pending.get(message.id)(message);
		}
	});
	const send = (method, params = {}, sessionId) => new Promise(resolve => {
		const i = ++id;
		pending.set(i, resolve);
		child.stdio[3].write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
	});
	const evaluate = async (sessionId, expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
	try {
		const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
		const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
		await send('Page.enable', {}, sessionId);
		await send('Page.addScriptToEvaluateOnNewDocument', {
			source: 'window.__WEBGLRIPPER_TEST__ = { downloads: [], onDownload(name, blob) { this.downloads.push({ name, blob }); } };'
		}, sessionId);
		await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/tests/demo.html` }, sessionId);
		await poll(() => evaluate(sessionId, '!!window.demoReady'), 60000);
		for (const [name, format] of [['plain.glb', 'glb'], ['stl.stl', 'stl'], ['usdz.usdz', 'usdz']]) {
			const data = await evaluate(sessionId, `(async () => {
				const hook = window.__WEBGLRIPPER_TEST__;
				hook.downloads.length = 0;
				await new Promise(resolve => {
					document.addEventListener('webglripper:ext', function listen(event) {
						const message = JSON.parse(event.detail);
						if (message.type === 'state' && ['done', 'error', 'idle'].includes(message.state)) {
							document.removeEventListener('webglripper:ext', listen);
							resolve();
						}
					});
					document.dispatchEvent(new CustomEvent('webglripper:page', { detail: JSON.stringify({ type: 'capture',
						settings: { __version: 'test', show_preview: false, export_format: '${format}' } }) }));
				});
				if (hook.downloads.length !== 1)
					return null;
				const bytes = new Uint8Array(await hook.downloads[0].blob.arrayBuffer());
				let text = '';
				for (let i = 0; i < bytes.length; i += 8192)
					text += String.fromCharCode(...bytes.subarray(i, i + 8192));
				return btoa(text);
			})()`);
			report(`demo ripped as ${format.toUpperCase()}`, !!data);
			if (data)
				fs.writeFileSync(path.join(folder, name), Buffer.from(data, 'base64'));
		}
	} finally {
		child.kill();
		server.close();
	}
}

async function main() {
	const blender = findBlender();
	const chrome = findChrome();
	if (!blender || !chrome) {
		console.error(`${blender ? 'Chrome' : 'Blender'} not found. Set the ${blender ? 'CHROME' : 'BLENDER'} environment variable.`);
		process.exit(2);
	}
	const samples = fs.mkdtempSync(path.join(os.tmpdir(), 'webglripper-samples-'));
	console.log('== Real rips (tests/demo.html) ==');
	await ripSamples(chrome, samples);

	console.log(`\n== Blender add-on (${blender}) ==`);
	const run = spawnSync(blender, ['-b', '--factory-startup', '--python', path.join(ROOT, 'tests/blender_addon_test.py'), '--', samples], {
		encoding: 'utf8',
		env: {
			...process.env,
			BLENDER_USER_SCRIPTS: fs.mkdtempSync(path.join(os.tmpdir(), 'webglripper-scripts-')),
			BLENDER_USER_CONFIG: fs.mkdtempSync(path.join(os.tmpdir(), 'webglripper-config-'))
		},
		timeout: 300000
	});
	const lines = `${run.stdout || ''}${run.stderr || ''}`.split(/\r?\n/);
	for (const line of lines.filter(l => /^(PASS|FAIL)\s/.test(l) || /Traceback|Error:/.test(l)))
		console.log(line);
	report('Blender add-on tests finished', run.status === 0 && lines.some(l => l.includes('All add-on tests passed')), run.error ? run.error.message : `exit ${run.status}`);
	fs.rmSync(samples, { recursive: true, force: true });
	console.log(failureCount() ? `\n${failureCount()} failure(s)` : '\nAll tests passed');
	process.exit(failureCount() ? 1 : 0);
}

main();
