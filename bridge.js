// Isolated-world content script: connects the page engine (webglripper.js) with the extension.
//  - delivers settings to the engine (and keeps them live when they change)
//  - listens for the capture hotkey and asks the background to start a capture in every frame of the tab
//  - relays progress to the popup (through a port) and to the background (toolbar badge)
(function () {
	'use strict';

	const api = globalThis.browser || globalThis.chrome;
	const TO_PAGE = 'webglripper:page';
	const TO_EXTENSION = 'webglripper:ext';
	const frameToken = Math.random().toString(36).slice(2);

	let settings = null;
	let pendingCommand = null;
	let engine = { contexts: 0, state: 'idle', text: '', result: null };
	const ports = new Set();

	function toPage(message) {
		document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(message) }));
	}

	function toBackground(message) {
		try {
			const sent = api.runtime.sendMessage(message);
			if (sent && typeof sent.catch === 'function')
				sent.catch(() => {});
			return true;
		} catch (err) {
			return false; // extension was reloaded or updated, this content script is orphaned
		}
	}

	function snapshot() {
		return { type: 'status', frame: frameToken, top: window === window.top, host: location.host, ...engine };
	}

	function toPorts(message) {
		for (const port of ports) {
			try {
				port.postMessage(message);
			} catch (err) {
				ports.delete(port);
			}
		}
	}

	/* kind is 'capture' (rip the next frame) or 'pick' (rip the object the user clicks next) */
	function startCapture(kind = 'capture') {
		if (!settings) {
			pendingCommand = kind; // settings are still loading, start as soon as they arrive
			return;
		}
		toPage({ type: kind === 'pick' ? 'pick' : 'capture', settings });
	}

	function applySettings(items) {
		settings = { ...items, __version: api.runtime.getManifest().version };
		toPage({ type: 'settings', settings });
		if (pendingCommand) {
			const kind = pendingCommand;
			pendingCommand = null;
			startCapture(kind);
		}
	}

	function loadSettings() {
		api.storage.sync.get(WEBGLRIPPER_DEFAULTS).then(applySettings, () => applySettings({ ...WEBGLRIPPER_DEFAULTS }));
	}

	// Messages from the page engine
	document.addEventListener(TO_EXTENSION, (event) => {
		let message;
		try {
			message = typeof event.detail === 'string' ? JSON.parse(event.detail) : null;
		} catch (err) {
			return;
		}
		if (!message || typeof message !== 'object')
			return;
		switch (message.type) {
			case 'ready':
				engine = { ...engine, contexts: message.contexts | 0, state: message.state || 'idle', text: message.text || '', result: message.result || null };
				if (settings)
					toPage({ type: 'settings', settings });
				break;
			case 'contexts':
				engine.contexts = message.count | 0;
				if (engine.contexts > 0)
					toBackground({ type: 'webglripper:contexts', count: engine.contexts });
				break;
			case 'state': {
				const previous = engine.state;
				engine.state = message.state;
				engine.text = message.text || '';
				engine.result = message.result || null;
				// frames without WebGL answer every command with 'idle'; only real changes go to the toolbar badge
				if (message.state !== 'idle' || (previous && previous !== 'idle'))
					toBackground({ type: 'webglripper:state', state: message.state, result: message.result || null });
				break;
			}
			default:
				return;
		}
		toPorts(snapshot());
	});

	// Hotkeys. Registered on window in the capture phase so pages that swallow key events can't block them.
	window.addEventListener('keydown', (event) => {
		if (event.repeat || !settings)
			return;
		const kind = WebGLRipperHotkey.matches(event, settings.pick_hotkey) ? 'pick'
			: WebGLRipperHotkey.matches(event, settings.capture_hotkey) ? 'capture' : null;
		if (!kind)
			return;
		const hotkey = kind === 'pick' ? settings.pick_hotkey : settings.capture_hotkey;
		const target = event.target;
		const typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
		if (typing && !WebGLRipperHotkey.hasModifier(hotkey) && /^(Key|Digit)/.test(event.code))
			return; // don't hijack plain letters while the user is typing
		// The background broadcasts to every frame, so a game inside an iframe is reached too
		if (!toBackground({ type: 'webglripper:hotkey', kind }))
			startCapture(kind);
	}, true);

	api.runtime.onMessage.addListener((message) => {
		if (message && message.type === 'webglripper:capture')
			startCapture(message.kind);
	});

	// The popup connects to every frame of the tab and aggregates the answers
	api.runtime.onConnect.addListener((port) => {
		if (port.name !== 'webglripper-popup')
			return;
		ports.add(port);
		port.onDisconnect.addListener(() => ports.delete(port));
		port.onMessage.addListener((message) => {
			if (message && (message.type === 'capture' || message.type === 'pick'))
				startCapture(message.type);
		});
		port.postMessage(snapshot());
	});

	api.storage.onChanged.addListener((changes, area) => {
		if (area === 'sync')
			loadSettings();
	});

	loadSettings();
	toPage({ type: 'hello' });
})();
