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
			show('done', done.text, result.filename ? `${result.filename} · ${result.drawCalls} draw calls` : '');
		} else if (failed) {
			show('error', failed.text);
		} else if (contexts > 0) {
			show('ready', `${contexts} WebGL canvas${contexts === 1 ? '' : 'es'} found. Ready to rip.`);
		} else {
			show('idle', 'No WebGL content detected on this page yet.');
		}
	}

	[tab] = await api.tabs.query({ active: true, currentWindow: true });
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
