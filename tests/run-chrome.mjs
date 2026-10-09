#!/usr/bin/env node
/*
 * Runs the WebGL Ripper tests in a real Chrome through the DevTools protocol (no dependencies).
 *
 *   node tests/run-chrome.mjs              engine tests, three.js test and the extension end-to-end test
 *   node tests/run-chrome.mjs --headful    same, with a visible browser window
 *   node tests/run-chrome.mjs --no-three   skip the three.js test (it loads three.js from a CDN)
 *
 * Set CHROME=<path to chrome.exe> if Chrome is not found automatically. Chrome 126 or newer is required.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addFailures, checkCubeZip, checkEditorResults, checkOptimizedResults, checkSkinnedResults, checkLargeExport, checkPickedCube, checkThreeResults, failureCount, poll, report, serve, sleep } from './common.mjs';
import { build } from '../scripts/build.mjs';
import { checkTranslations } from './i18n-check.mjs';

const HEADFUL = process.argv.includes('--headful');
const SKIP_THREE = process.argv.includes('--no-three');

function findChrome() {
	if (process.env.CHROME)
		return process.env.CHROME;
	const candidates = process.platform === 'win32' ? [
		path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
		'C:/Program Files/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
	] : process.platform === 'darwin' ? [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
	] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
	return candidates.find(p => fs.existsSync(p));
}

class DevTools {
	constructor(child) {
		this.nextId = 0;
		this.pending = new Map();
		this.listeners = new Set();
		this.input = child.stdio[3];
		let buffered = Buffer.alloc(0);
		child.stdio[4].on('data', (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			let end;
			while ((end = buffered.indexOf(0)) >= 0) {
				const message = JSON.parse(buffered.subarray(0, end).toString('utf8'));
				buffered = buffered.subarray(end + 1);
				this.dispatch(message);
			}
		});
	}

	dispatch(message) {
		if (message.id && this.pending.has(message.id)) {
			const { resolve, reject, method } = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error)
				reject(new Error(`${method}: ${message.error.message}`));
			else
				resolve(message.result);
			return;
		}
		for (const listener of this.listeners)
			listener(message);
	}

	send(method, params = {}, sessionId) {
		const id = ++this.nextId;
		this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
	}

	on(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

async function openPage(devtools, url) {
	const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
	const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
	const errors = [];
	const logs = [];
	devtools.on(message => {
		if (message.sessionId !== sessionId)
			return;
		if (message.method === 'Runtime.exceptionThrown')
			errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
		if (message.method === 'Runtime.consoleAPICalled') {
			const text = message.params.args.map(a => a.value ?? a.description ?? '').join(' ');
			logs.push(`[${message.params.type}] ${text}`);
			if (message.params.type === 'error')
				errors.push(text);
		}
	});
	await devtools.send('Runtime.enable', {}, sessionId);
	await devtools.send('Page.enable', {}, sessionId);
	await devtools.send('Page.navigate', { url }, sessionId);
	return { targetId, sessionId, errors, logs };
}

async function evaluate(devtools, sessionId, expression) {
	const result = await devtools.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
	if (result.exceptionDetails)
		throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result.value;
}

/* ------------------------------------------------------------------------------------------------------------ */

async function engineTests(devtools, base) {
	console.log('\n== Engine tests (tests/engine.html) ==');
	const page = await openPage(devtools, `${base}/tests/engine.html`);
	const results = await poll(() => evaluate(devtools, page.sessionId, 'window.testResults || null'), 60000);
	if (!results) {
		report('engine tests finished', false, page.errors.concat(page.logs.slice(-10)));
		return;
	}
	const lines = await evaluate(devtools, page.sessionId, `Array.from(document.querySelectorAll('#log div')).map(d => d.textContent)`);
	for (const line of lines)
		console.log(line);
	addFailures(results.failed);
	report('no uncaught page errors', page.errors.length === 0, page.errors);
	await devtools.send('Target.closeTarget', { targetId: page.targetId });
}

async function largeExportTest(devtools, base) {
	console.log('\n== Large export (tests/heavy.html: 90k vertices, 4096x4096 texture) ==');
	const page = await openPage(devtools, `${base}/tests/heavy.html?grid=300&textures=1&size=4096`);
	await poll(() => evaluate(devtools, page.sessionId, 'window.ready === true'), 30000);
	await sleep(500);
	const result = await evaluate(devtools, page.sessionId, `runCapture({ export_layout: 'both', export_format: 'obj', show_preview: false, center_model: false })`);
	const zip = result.state === 'done' ? Buffer.from(await evaluate(devtools, page.sessionId, 'downloadBase64(0)'), 'base64') : Buffer.alloc(0);
	checkLargeExport(result, zip);
	report('no uncaught page errors', page.errors.length === 0, page.errors);
	await devtools.send('Target.closeTarget', { targetId: page.targetId });
}

async function threeTests(devtools, base) {
	console.log('\n== three.js test (tests/three.html) ==');
	const page = await openPage(devtools, `${base}/tests/three.html`);
	const results = await poll(() => evaluate(devtools, page.sessionId, 'window.testResults || null'), 30000);
	if (!results) {
		report('three.js capture finished (needs network access to cdn.jsdelivr.net)', false, page.errors.concat(page.logs.slice(-5)));
		return;
	}
	checkThreeResults(results);
	report('no uncaught page errors', page.errors.length === 0, page.errors);
	await devtools.send('Target.closeTarget', { targetId: page.targetId });

	console.log('\n== Editor-style viewer (tests/editor.html) ==');
	const editor = await openPage(devtools, `${base}/tests/editor.html`);
	const editorResults = await poll(() => evaluate(devtools, editor.sessionId, 'window.testResults || null'), 30000);
	if (!editorResults) {
		report('editor viewer capture finished', false, editor.errors.concat(editor.logs.slice(-5)));
		return;
	}
	checkEditorResults(editorResults);
	report('no uncaught page errors', editor.errors.length === 0, editor.errors);
	await devtools.send('Target.closeTarget', { targetId: editor.targetId });

	console.log('\n== Posed characters (tests/skinned.html) ==');
	const skinned = await openPage(devtools, `${base}/tests/skinned.html`);
	const skinnedResults = await poll(() => evaluate(devtools, skinned.sessionId, 'window.testResults || null'), 30000);
	if (!skinnedResults) {
		report('posed characters capture finished', false, skinned.errors.concat(skinned.logs.slice(-5)));
		return;
	}
	checkSkinnedResults(skinnedResults);
	report('no uncaught page errors', skinned.errors.length === 0, skinned.errors);
	await devtools.send('Target.closeTarget', { targetId: skinned.targetId });

	console.log('\n== Optimized glTF model (tests/optimized.html) ==');
	const optimized = await openPage(devtools, `${base}/tests/optimized.html`);
	const optimizedResults = await poll(() => evaluate(devtools, optimized.sessionId, 'window.testResults || null'), 30000);
	if (!optimizedResults) {
		report('optimized model capture finished', false, optimized.errors.concat(optimized.logs.slice(-5)));
		return;
	}
	checkOptimizedResults(optimizedResults);
	report('no uncaught page errors', optimized.errors.length === 0, optimized.errors);
	await devtools.send('Target.closeTarget', { targetId: optimized.targetId });
}

async function extensionTests(devtools, base) {
	console.log('\n== Extension end-to-end (dist/chrome package) ==');
	let extensionId;
	try {
		const { chrome } = build({ quiet: true });
		({ id: extensionId } = await devtools.send('Extensions.loadUnpacked', { path: chrome.dir }));
		report('extension loads', !!extensionId);
	} catch (err) {
		report('extension loads', false, err.message);
		return;
	}

	// Developer mode makes Chrome collect runtime errors of the extension, checked at the end
	const extensionsPage = await openPage(devtools, 'chrome://extensions');
	await sleep(1000);
	await evaluate(devtools, extensionsPage.sessionId, 'chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');

	// The frame broadcast test downloads right away and checks both formats
	const settingsPage = await openPage(devtools, `chrome-extension://${extensionId}/options.html`);
	await sleep(500);
	// English first (Chrome follows the system language otherwise); the Russian interface is checked further down
	await evaluate(devtools, settingsPage.sessionId, `chrome.storage.sync.set({ show_preview: false, export_format: 'both', language: 'en' })`);

	const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webglripper-downloads-'));
	const downloads = new Map();
	devtools.on(message => {
		if (message.method === 'Browser.downloadWillBegin')
			downloads.set(message.params.guid, { name: message.params.suggestedFilename, done: false });
		if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed' && downloads.has(message.params.guid))
			downloads.get(message.params.guid).done = true;
	});
	await devtools.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true });

	const page = await openPage(devtools, `${base}/tests/e2e.html`);
	const engine = await poll(() => evaluate(devtools, page.sessionId, `!!window[Symbol.for('webglripper.engine')]`), 10000);
	report('engine injected into the page (MAIN world, document_start)', !!engine);
	report('no extension globals leak into the page', await evaluate(devtools, page.sessionId,
		`typeof OBJUtils === 'undefined' && typeof Downloader === 'undefined' && typeof RIPPERS === 'undefined' && !document.getElementById('webgl_ripper_settings')`));
	await sleep(1500); // let the iframe load and both frames render

	await devtools.send('Page.bringToFront', {}, page.sessionId);
	for (const type of ['keyDown', 'keyUp'])
		await devtools.send('Input.dispatchKeyEvent', { type, key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45, nativeVirtualKeyCode: 45 }, page.sessionId);

	const finished = await poll(() => {
		const list = Array.from(downloads.values());
		return list.length >= 2 && list.every(d => d.done) ? list : null;
	}, 30000);
	report('Insert key rips the top frame and the cross-origin iframe', !!finished, Array.from(downloads.values()));
	if (finished) {
		for (const [guid, download] of downloads)
			checkCubeZip(download.name, fs.readFileSync(path.join(downloadDir, guid)));
	}
	report('no page errors during the rip', page.errors.length === 0, page.errors);

	// Background worker (started on demand by the hotkey message) and the toolbar badge it maintains
	const worker = await poll(async () => {
		const { targetInfos } = await devtools.send('Target.getTargets');
		return targetInfos.find(t => t.type === 'service_worker' && t.url.includes(extensionId));
	}, 5000);
	report('background service worker running', !!worker);
	if (worker) {
		const { sessionId } = await devtools.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
		const badge = await evaluate(devtools, sessionId,
			`chrome.tabs.query({ url: '${base}/tests/e2e.html' }).then(([tab]) => chrome.action.getBadgeText({ tabId: tab.id }))`);
		report('toolbar badge shows the number of ripped meshes', badge === '1', badge);
	}

	// Pick mode, the preview and GLB, with real keyboard and mouse input
	await evaluate(devtools, settingsPage.sessionId, `chrome.storage.sync.set({ show_preview: true, export_format: 'glb' })`);
	const single = await openPage(devtools, `${base}/tests/e2e-frame.html`);
	await poll(() => evaluate(devtools, single.sessionId, `!!window[Symbol.for('webglripper.engine')]`), 10000);
	await evaluate(devtools, single.sessionId, `(window.__states = [], document.addEventListener('webglripper:ext', (e) => { const m = JSON.parse(e.detail); if (m.type === 'state') window.__states.push(m.state); }), true)`);
	await sleep(1000);
	await devtools.send('Page.bringToFront', {}, single.sessionId);
	const before = downloads.size;
	for (const type of ['keyDown', 'keyUp'])
		await devtools.send('Input.dispatchKeyEvent', { type, key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45, nativeVirtualKeyCode: 45, modifiers: type === 'keyDown' ? 8 : 0 }, single.sessionId);
	report('Shift+Insert enters pick mode', !!await poll(() => evaluate(devtools, single.sessionId, `window.__states.includes('picking')`), 5000));
	const center = await evaluate(devtools, single.sessionId, `(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
		await devtools.send('Input.dispatchMouseEvent', { type, x: center.x, y: center.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, single.sessionId);
	const preview = await poll(() => evaluate(devtools, single.sessionId, `window.__states.includes('preview')`), 15000);
	report('clicking the cube opens the preview', !!preview, await evaluate(devtools, single.sessionId, 'window.__states'));
	if (preview) {
		await sleep(800);
		if (process.env.WEBGLRIPPER_SCREENSHOTS) {
			const { data } = await devtools.send('Page.captureScreenshot', { format: 'png' }, single.sessionId);
			fs.writeFileSync(path.join(process.env.WEBGLRIPPER_SCREENSHOTS, 'preview-chrome.png'), Buffer.from(data, 'base64'));
		}
		// V records a turntable video of the selection
		const beforeVideo = downloads.size;
		for (const type of ['keyDown', 'keyUp'])
			await devtools.send('Input.dispatchKeyEvent', { type, key: 'v', code: 'KeyV', text: type === 'keyDown' ? 'v' : undefined, windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 }, single.sessionId);
		const video = await poll(() => Array.from(downloads.entries()).slice(beforeVideo).find(([, d]) => d.done && d.name.endsWith('.webm')), 20000);
		const webm = video ? fs.readFileSync(path.join(downloadDir, video[0])) : Buffer.alloc(0);
		report('V in the preview records a turntable video (WebM)', webm.length > 2000 && webm.readUInt32BE(0) === 0x1A45DFA3, video ? { name: video[1].name, bytes: webm.length } : Array.from(downloads.values()));
		for (const type of ['keyDown', 'keyUp'])
			await devtools.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, single.sessionId);
		const glb = await poll(() => Array.from(downloads.entries()).slice(before).find(([, d]) => d.done && d.name.endsWith('.glb')), 20000);
		report('Enter in the preview downloads a .glb', !!glb, Array.from(downloads.values()));
		if (glb)
			checkPickedCube(glb[1].name, fs.readFileSync(path.join(downloadDir, glb[0])));
	}
	report('no page errors in pick mode and the preview', single.errors.length === 0, single.errors);

	// Without the preview the download starts right after the click; it must not be swallowed with that click
	await evaluate(devtools, settingsPage.sessionId, `chrome.storage.sync.set({ show_preview: false })`);
	await sleep(300);
	const beforeQuick = downloads.size;
	for (const type of ['keyDown', 'keyUp'])
		await devtools.send('Input.dispatchKeyEvent', { type, key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45, nativeVirtualKeyCode: 45, modifiers: type === 'keyDown' ? 8 : 0 }, single.sessionId);
	await poll(() => evaluate(devtools, single.sessionId, `window.__states.filter(s => s === 'picking').length === 2`), 5000);
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
		await devtools.send('Input.dispatchMouseEvent', { type, x: center.x, y: center.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, single.sessionId);
	const quick = await poll(() => Array.from(downloads.entries()).slice(beforeQuick).find(([, d]) => d.done && d.name.endsWith('.glb')), 20000);
	report('pick without the preview downloads right away', !!quick, Array.from(downloads.values()).slice(beforeQuick));
	if (quick)
		checkPickedCube(quick[1].name, fs.readFileSync(path.join(downloadDir, quick[0])));

	// The popup tells what is on the page and what the last rip saved
	const [frameTab] = await evaluate(devtools, settingsPage.sessionId, `chrome.tabs.query({ url: '${base}/tests/e2e-frame.html' })`);
	const found = await openPage(devtools, `chrome-extension://${extensionId}/popup.html?tab=${frameTab.id}`);
	const shown = await poll(() => evaluate(devtools, found.sessionId, `document.getElementById('last').hidden ? null : ({
		canvases: Array.from(document.querySelectorAll('#canvas-list .chip'), c => c.textContent),
		objects: Array.from(document.querySelectorAll('#objects .object'), o => ({
			thumbnail: (o.querySelector('img.thumb') || {}).src || '', name: o.querySelector('.name').textContent, info: o.querySelector('.info').textContent
		})),
		meta: document.getElementById('last-meta').textContent, status: document.getElementById('status-text').textContent
	})`), 5000);
	report('popup lists the WebGL canvas of the page', !!shown && shown.canvases.length === 1 && /^\d+×\d+ · WebGL [12]$/.test(shown.canvases[0]), shown);
	report('popup shows the saved object with a rendered thumbnail, triangles and texture', !!shown && shown.objects.length === 1 &&
		/^data:image\/(webp|png);base64,/.test(shown.objects[0].thumbnail) && /picked/.test(shown.objects[0].name) &&
		/12 triangles · \d+×\d+ texture/.test(shown.objects[0].info) && /^1 object · GLB/.test(shown.meta) && /^Saved 1 mesh and 1 texture\.$/.test(shown.status), shown);
	report('no errors in the popup after a rip', found.errors.length === 0, found.errors);
	await devtools.send('Target.closeTarget', { targetId: found.targetId });

	// The history keeps every finished rip: site, file, numbers and thumbnails
	const historyPage = await openPage(devtools, `chrome-extension://${extensionId}/history.html`);
	const rips = await poll(() => evaluate(devtools, historyPage.sessionId, `(() => {
		const items = Array.from(document.querySelectorAll('#rips .rip'));
		return items.length >= 4 ? items.map(item => ({
			host: item.querySelector('.host').textContent, thumbnails: item.querySelectorAll('img.thumb').length,
			facts: item.querySelector('.facts').textContent, file: item.querySelector('.filename').textContent
		})) : null;
	})()`), 5000);
	report('history lists every rip with its site, file and thumbnail', !!rips && rips.length === 4 && rips[0].host === '127.0.0.1' &&
		rips[0].thumbnails === 1 && rips[0].facts === '1 object · 1 texture · GLB' && /^webglripper_.+\.glb$/.test(rips[0].file) &&
		rips.filter(rip => /\.zip$/.test(rip.file)).length === 2, rips);
	const listed = await evaluate(devtools, historyPage.sessionId, `document.querySelectorAll('#rips .rip').length`);
	await evaluate(devtools, historyPage.sessionId, `document.querySelector('#rips .rip .remove').click()`);
	report('a rip can be removed from the history', listed === 4 && !!await poll(() => evaluate(devtools, historyPage.sessionId, `document.querySelectorAll('#rips .rip').length === 3`), 3000), listed);
	report('no errors on the history page', historyPage.errors.length === 0, historyPage.errors);
	await devtools.send('Target.closeTarget', { targetId: historyPage.targetId });

	// Russian interface: the page (pick hint, progress, result), the popup, the options and the history
	await evaluate(devtools, settingsPage.sessionId, `chrome.storage.sync.set({ language: 'ru' })`);
	await sleep(300);
	await evaluate(devtools, single.sessionId, `(window.__texts = [], document.addEventListener('webglripper:ext', (e) => { const m = JSON.parse(e.detail); if (m.type === 'state') window.__texts.push(m.text); }), true)`);
	await devtools.send('Page.bringToFront', {}, single.sessionId);
	for (const type of ['keyDown', 'keyUp'])
		await devtools.send('Input.dispatchKeyEvent', { type, key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45, nativeVirtualKeyCode: 45, modifiers: type === 'keyDown' ? 8 : 0 }, single.sessionId);
	await poll(() => evaluate(devtools, single.sessionId, `window.__states.filter(s => s === 'picking').length === 3`), 5000);
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
		await devtools.send('Input.dispatchMouseEvent', { type, x: center.x, y: center.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, single.sessionId);
	const saved = await poll(() => evaluate(devtools, single.sessionId, `window.__texts.find(text => /^Сохранено/.test(text)) || null`), 20000);
	const texts = await evaluate(devtools, single.sessionId, 'window.__texts');
	report('the page speaks Russian: pick mode, progress and the result', saved === 'Сохранено: 1 меш и 1 текстура.' &&
		texts.includes('Щёлкните на странице объект, который нужно сохранить.') && texts.some(text => /^Записано: 1 меш из \d+ вызов/.test(text)), texts);

	const ruPopup = await openPage(devtools, `chrome-extension://${extensionId}/popup.html?tab=${frameTab.id}`);
	const ruShown = await poll(() => evaluate(devtools, ruPopup.sessionId, `document.getElementById('last').hidden ? null : ({
		lang: document.documentElement.lang, button: document.getElementById('capture').textContent, pick: document.getElementById('pick').textContent,
		heading: document.querySelector('#last h2').textContent, meta: document.getElementById('last-meta').textContent,
		info: document.querySelector('#objects .info').textContent, status: document.getElementById('status-text').textContent,
		links: document.querySelector('footer .links').textContent
	})`), 5000);
	report('popup in Russian', !!ruShown && ruShown.lang === 'ru' && ruShown.button === 'Захватить кадр' && ruShown.pick === 'Выбрать объект' &&
		ruShown.heading === 'Последний рип' && ruShown.meta === '1 объект · GLB · 1 текстура' && /^12 треугольников · текстура \d+×\d+/.test(ruShown.info) &&
		ruShown.status === 'Сохранено: 1 меш и 1 текстура.' && ruShown.links === 'История · Настройки', ruShown);
	report('no errors in the Russian popup', ruPopup.errors.length === 0, ruPopup.errors);
	await devtools.send('Target.closeTarget', { targetId: ruPopup.targetId });

	const ruOptions = await openPage(devtools, `chrome-extension://${extensionId}/options.html`);
	const ruOptionsShown = await poll(() => evaluate(devtools, ruOptions.sessionId, `document.documentElement.classList.contains('i18n-pending') ? null : ({
		title: document.title, sections: Array.from(document.querySelectorAll('h2'), h => h.textContent), language: document.getElementById('language').value,
		version: document.getElementById('version').textContent, placeholder: document.getElementById('extra_position_names').placeholder
	})`), 5000);
	report('options in Russian', !!ruOptionsShown && ruOptionsShown.title === 'Настройки WebGL Ripper' && ruOptionsShown.language === 'ru' &&
		ruOptionsShown.sections.join(',') === 'Интерфейс,Захват,Вывод,Текстуры,Дополнительно' && /^Версия \d/.test(ruOptionsShown.version) &&
		ruOptionsShown.placeholder === 'например, in_ATTRIBUTE0', ruOptionsShown);
	report('no errors on the Russian options page', ruOptions.errors.length === 0, ruOptions.errors);
	await devtools.send('Target.closeTarget', { targetId: ruOptions.targetId });

	const ruHistory = await openPage(devtools, `chrome-extension://${extensionId}/history.html`);
	const ruRips = await poll(() => evaluate(devtools, ruHistory.sessionId, `document.querySelectorAll('#rips .rip').length === 4 ? ({
		title: document.querySelector('h1').textContent, summary: document.getElementById('summary').textContent,
		facts: document.querySelector('#rips .facts').textContent, show: document.querySelector('#rips .file button').textContent
	}) : null`), 5000);
	report('history in Russian, newest rip first', !!ruRips && ruRips.title === 'История рипов' && ruRips.summary === '4 рипа' &&
		ruRips.facts === '1 объект · 1 текстура · GLB' && ruRips.show === 'Показать в папке', ruRips);
	await evaluate(devtools, ruHistory.sessionId, `document.getElementById('clear').click()`);
	await evaluate(devtools, ruHistory.sessionId, `document.getElementById('clear').click()`);
	const cleared = await poll(() => evaluate(devtools, ruHistory.sessionId, `!document.getElementById('empty').hidden && !document.querySelector('#rips .rip')
		? document.getElementById('empty').textContent.replace(/\\s+/g, ' ').trim() : null`), 3000);
	report('the history can be cleared', cleared === 'Пока ничего не сохранено. Нажмите Insert на странице с 3D или кнопку расширения на панели инструментов.', cleared);
	report('no errors on the Russian history page', ruHistory.errors.length === 0, ruHistory.errors);
	await devtools.send('Target.closeTarget', { targetId: ruHistory.targetId });
	await evaluate(devtools, settingsPage.sessionId, `chrome.storage.sync.set({ language: 'auto' })`);

	// Options page
	const options = await openPage(devtools, `chrome-extension://${extensionId}/options.html`);
	await sleep(800);
	const initial = await evaluate(devtools, options.sessionId, `({ zip: document.getElementById('should_download_zip').checked, layout: document.getElementById('export_layout').value, hotkey: document.getElementById('hotkey-record').textContent })`);
	report('options page shows defaults', initial.zip === true && initial.layout === 'separate' && initial.hotkey === 'Insert', initial);
	await evaluate(devtools, options.sessionId, `(() => { const s = document.getElementById('export_layout'); s.value = 'both'; s.dispatchEvent(new Event('change')); })()`);
	await sleep(300);
	const stored = await evaluate(devtools, options.sessionId, `chrome.storage.sync.get('export_layout').then(r => r.export_layout)`);
	report('options are saved on change', stored === 'both', stored);
	await evaluate(devtools, options.sessionId, `document.getElementById('hotkey-record').click()`);
	for (const type of ['keyDown', 'keyUp'])
		await devtools.send('Input.dispatchKeyEvent', { type, key: 'F8', code: 'F8', windowsVirtualKeyCode: 119, modifiers: type === 'keyDown' ? 2 : 0 }, options.sessionId);
	await sleep(300);
	const hotkey = await evaluate(devtools, options.sessionId, `chrome.storage.sync.get('capture_hotkey').then(r => r.capture_hotkey)`);
	report('hotkey recorder stores Ctrl+F8', hotkey === 'Ctrl+F8', hotkey);
	await evaluate(devtools, options.sessionId, `document.getElementById('reset').click()`);
	await sleep(400);
	const reset = await evaluate(devtools, options.sessionId, `chrome.storage.sync.get(null)`);
	report('reset restores defaults', reset.export_layout === 'separate' && reset.capture_hotkey === 'Insert', reset);
	report('no errors on the options page', options.errors.length === 0, options.errors);

	// Popup (opened as a tab it inspects itself, which must be handled gracefully)
	const popup = await openPage(devtools, `chrome-extension://${extensionId}/popup.html`);
	await sleep(1200);
	const popupState = await evaluate(devtools, popup.sessionId, `({ state: document.getElementById('status').dataset.state, text: document.getElementById('status-text').textContent, version: document.getElementById('version').textContent })`);
	report('popup renders without a WebGL tab', popupState.state === 'unavailable' && /^v\d/.test(popupState.version), popupState);
	report('no errors in the popup', popup.errors.length === 0, popup.errors);

	const problems = await evaluate(devtools, extensionsPage.sessionId, `chrome.developerPrivate.getExtensionsInfo()
		.then(list => list.find(e => e.id === '${extensionId}'))
		.then(e => ({ installWarnings: e.installWarnings, manifestErrors: e.manifestErrors, runtimeErrors: e.runtimeErrors.map(r => r.message) }))`);
	report('Chrome reports no manifest warnings or extension errors',
		!problems.installWarnings.length && !problems.manifestErrors.length && !problems.runtimeErrors.length, problems);
}

async function main() {
	const chrome = findChrome();
	if (!chrome) {
		console.error('Chrome not found. Set the CHROME environment variable.');
		process.exit(2);
	}
	const server = await serve();
	const base = `http://127.0.0.1:${server.address().port}`;
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webglripper-profile-'));
	const args = [
		`--user-data-dir=${profile}`,
		'--remote-debugging-pipe',
		'--enable-unsafe-extension-debugging',
		'--enable-unsafe-swiftshader',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-search-engine-choice-screen',
		...(HEADFUL ? [] : ['--headless=new']),
		'about:blank'
	];
	const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
	const devtools = new DevTools(child);
	try {
		const version = await devtools.send('Browser.getVersion');
		console.log(`Using ${version.product}`);
		console.log('\n== Translations ==');
		const translations = checkTranslations();
		report(`every interface text is translated (${translations.texts} texts)`, translations.problems.length === 0, translations.problems);
		await engineTests(devtools, base);
		await largeExportTest(devtools, base);
		if (!SKIP_THREE)
			await threeTests(devtools, base);
		await extensionTests(devtools, base);
	} catch (err) {
		report('test runner', false, err.stack || String(err));
	} finally {
		await devtools.send('Browser.close').catch(() => {});
		child.kill();
		server.close();
	}
	console.log(failureCount() ? `\n${failureCount()} failure(s)` : '\nAll tests passed');
	process.exit(failureCount() ? 1 : 0);
}

main();
