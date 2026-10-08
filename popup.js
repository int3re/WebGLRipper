(async function () {
	'use strict';

	const api = globalThis.browser || globalThis.chrome;
	const $ = (id) => document.getElementById(id);
	const BUSY = ['waiting', 'capturing', 'exporting', 'picking', 'preview'];
	const frames = new Map();   // frame token -> last status reported by that frame
	let connected = false;
	let port = null;
	let tab = null;

	$('version').textContent = `v${api.runtime.getManifest().version}`;
	$('open-options').addEventListener('click', (event) => {
		event.preventDefault();
		api.runtime.openOptionsPage();
		window.close();
	});
	api.storage.sync.get(WEBGLRIPPER_DEFAULTS).then(items => {
		$('hotkey').textContent = WebGLRipperHotkey.label(items.capture_hotkey);
		$('pick-hotkey').textContent = WebGLRipperHotkey.label(items.pick_hotkey);
	});

	const formatCount = (n) => Number(n || 0).toLocaleString('en-US').replace(/,/g, '\u202f');
	const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
	const FORMATS = { glb: 'GLB', obj: 'OBJ', both: 'GLB + OBJ' };

	function element(tag, className, text) {
		const node = document.createElement(tag);
		if (className)
			node.className = className;
		if (text !== undefined)
			node.textContent = text;
		return node;
	}

	/* The WebGL canvases of every frame of the tab. */
	function renderCanvases(list) {
		const canvases = list.flatMap(frame => (Array.isArray(frame.canvases) ? frame.canvases : [])
			.map(canvas => ({ ...canvas, host: frame.top ? '' : String(frame.host || '') })));
		$('canvases').hidden = canvases.length === 0;
		const chips = $('canvas-list');
		chips.replaceChildren();
		for (const canvas of canvases.slice(0, 4)) {
			const chip = element('span', 'chip', `${canvas.width | 0}×${canvas.height | 0} · ${canvas.api === 'WebGL 2' ? 'WebGL 2' : 'WebGL 1'}`);
			if (canvas.host)
				chip.title = `In a frame from ${canvas.host}`;
			chips.append(chip);
		}
		if (canvases.length > 4)
			chips.append(element('span', 'chip', `+${canvases.length - 4}`));
	}

	/* What the last rip saved: thumbnails, triangles, textures, size, and what it left out. */
	function renderLast(frame) {
		const result = frame && frame.result;
		const objects = result && Array.isArray(result.objects) ? result.objects : [];
		$('last').hidden = objects.length === 0;
		if (!objects.length)
			return;
		$('last-meta').textContent = [plural(result.meshes, 'object'), FORMATS[result.format] || '', result.textures ? plural(result.textures, 'texture') : '']
			.filter(Boolean).join(' · ');
		const list = $('objects');
		list.replaceChildren();
		for (const object of objects) {
			const item = element('li', 'object');
			if (typeof object.thumbnail === 'string' && /^data:image\/(webp|png);base64,[A-Za-z0-9+/=]+$/.test(object.thumbnail)) {
				const image = element('img', 'thumb');
				image.alt = '';
				image.src = object.thumbnail;
				item.append(image);
			} else {
				const swatch = element('span', 'thumb swatch');
				if (/^#[0-9a-f]{6}$/i.test(object.color || ''))
					swatch.style.background = object.color;
				item.append(swatch);
			}
			const text = element('div', 'text');
			const name = element('div', 'name', String(object.name || 'mesh'));
			if (object.picked)
				name.append(element('span', 'badge', 'picked'));
			const info = [plural(object.triangles, 'triangle')];
			if (object.texture)
				info.push(`${object.texture} texture`);
			else if (object.textures)
				info.push(plural(object.textures, 'texture'));
			if (Array.isArray(object.size))
				info.push(object.size.map(n => Number(n)).join(' × '));
			text.append(name, element('div', 'info', info.join(' · ')));
			item.append(text);
			list.append(item);
		}
		const more = (result.meshes | 0) - objects.length;
		$('more').hidden = more <= 0;
		$('more').textContent = more > 0 ? `+ ${plural(more, 'smaller object')}` : '';
		const out = result.leftOut || {};
		const parts = [
			[out.gizmos, 'gizmo part'], [out.corner, 'corner helper'], [out.passes, 'full-screen pass'],
			[out.duplicates, 'shadow/depth copy', 'shadow/depth copies'], [out.background, 'background'],
			[out.unselected, 'unselected mesh']
		].filter(([n]) => n > 0).map(([n, word, many]) => (n === 1 || !many ? plural(n, word) : `${formatCount(n)} ${many}`));
		$('left-out').hidden = parts.length === 0;
		$('left-out').textContent = parts.length ? `Left out: ${parts.join(' · ')}` : '';
	}

	function show(state, text, detail) {
		$('status').dataset.state = state;
		$('status-text').textContent = text;
		$('detail').hidden = !detail;
		$('detail').textContent = detail || '';
	}

	function unavailable() {
		if (connected)
			return;
		const button = $('capture');
		$('pick').disabled = true;
		const url = tab && tab.url ? tab.url : '';
		if (/^file:/.test(url)) {
			show('unavailable', 'To rip local files, enable "Allow access to file URLs" in the extension details, then reload this tab.');
			button.disabled = true;
		} else if (/^https?:/.test(url)) {
			show('unavailable', 'This tab was opened before WebGL Ripper was installed or updated. Reload it to start ripping.');
			button.textContent = 'Reload tab';
			button.disabled = false;
			button.onclick = () => {
				api.tabs.reload(tab.id);
				window.close();
			};
		} else {
			show('unavailable', 'WebGL Ripper can\'t run on this page.');
			button.disabled = true;
		}
	}

	function render() {
		const list = Array.from(frames.values());
		const contexts = list.reduce((sum, f) => sum + (f.contexts || 0), 0);
		renderCanvases(list);
		renderLast(list.find(f => f.state === 'done' && f.result));
		const button = $('capture');
		button.onclick = null;
		button.textContent = 'Rip next frame';

		const busy = list.find(f => BUSY.includes(f.state));
		if (busy) {
			show(busy.state, busy.text || 'Working…');
			button.disabled = true;
			$('pick').disabled = true;
			return;
		}
		button.disabled = false;
		$('pick').disabled = contexts === 0;

		const done = list.find(f => f.state === 'done');
		const failed = list.find(f => f.state === 'error');
		if (done) {
			const result = done.result || {};
			show('done', done.text, result.filename ? `${result.filename} · ${plural(result.drawCalls, 'draw call')}` : '');
		} else if (failed) {
			show('error', failed.text);
		} else if (contexts > 0) {
			show('ready', `${contexts} WebGL canvas${contexts === 1 ? '' : 'es'} found. Ready to rip.`);
		} else {
			show('idle', 'No WebGL content detected on this page yet.');
		}
	}

	// popup.html?tab=<id> shows that tab: the tests open the popup as a page of its own
	const forcedTab = Number(new URLSearchParams(location.search).get('tab'));
	[tab] = forcedTab ? [await api.tabs.get(forcedTab).catch(() => null)] : await api.tabs.query({ active: true, currentWindow: true });
	if (!tab || tab.id === undefined) {
		unavailable();
		return;
	}

	try {
		port = api.tabs.connect(tab.id, { name: 'webglripper-popup' });
	} catch (err) {
		unavailable();
		return;
	}
	port.onMessage.addListener((message) => {
		if (!message || message.type !== 'status')
			return;
		connected = true;
		frames.set(message.frame, message);
		render();
	});
	port.onDisconnect.addListener(() => {
		void api.runtime.lastError; // "Receiving end does not exist" is expected on pages without our content scripts
		if (!connected)
			unavailable();
	});
	// Every frame answers immediately on connect; silence means our content scripts aren't in this tab.
	setTimeout(unavailable, 800);

	$('capture').addEventListener('click', () => {
		if (!connected || $('capture').onclick)
			return;
		port.postMessage({ type: 'capture' });
		show('waiting', 'Starting capture…');
		$('capture').disabled = true;
		setTimeout(render, 3000); // in case no frame answers
	});
	$('pick').addEventListener('click', () => {
		if (!connected)
			return;
		port.postMessage({ type: 'pick' });
		window.close(); // the next click goes to the page
	});
})();
