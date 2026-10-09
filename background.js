// Background (service worker in Chrome, event page in Firefox).
// Broadcasts captures to every frame of a tab, keeps the toolbar badge up to date and remembers the rips.
'use strict';

const api = globalThis.browser || globalThis.chrome;

const BADGES = {
	ready: { text: 'GL', color: '#2e7d32' },
	waiting: { text: '…', color: '#f9a825' },
	capturing: { text: 'REC', color: '#c62828' },
	picking: { text: 'PICK', color: '#6a1b9a' },
	preview: { text: 'SEL', color: '#1565c0' },
	exporting: { text: '…', color: '#1565c0' },
	error: { text: '!', color: '#ef6c00' }
};

const resetTimers = new Map();
const HISTORY_SIZE = 50;
let historyQueue = Promise.resolve();

/* Keeps the last rips (what was saved, thumbnails, where from) for the history page. */
function rememberRip(result, sender) {
	if (!result || !result.filename || (sender.tab && sender.tab.incognito))
		return;
	const page = result.page && typeof result.page === 'object' ? result.page : {};
	const objects = Array.isArray(result.objects) ? result.objects.slice(0, 12) : [];
	const entry = {
		id: String(result.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
		time: Date.now(),
		url: String(page.url || sender.url || ''),
		host: String(page.host || ''),
		title: String(page.title || (sender.tab && sender.tab.title) || ''),
		format: String(result.format || ''),
		filename: String(result.filename),
		files: result.files | 0,
		meshes: result.meshes | 0,
		textures: result.textures | 0,
		objects,
		leftOut: result.leftOut || {}
	};
	// one write at a time: two frames can finish together
	historyQueue = historyQueue.then(async () => {
		const { keep_history: keep } = await api.storage.sync.get({ keep_history: true }).catch(() => ({ keep_history: true }));
		if (!keep)
			return;
		const { history = [] } = await api.storage.local.get('history');
		if (history.some(other => other.id === entry.id))
			return; // the same rip reported again
		history.unshift(entry);
		await api.storage.local.set({ history: history.slice(0, HISTORY_SIZE) });
	}).catch(() => {});
}

function setBadge(tabId, badge) {
	clearTimeout(resetTimers.get(tabId));
	resetTimers.delete(tabId);
	api.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(() => {});
	api.action.setBadgeText({ tabId, text: badge.text }).catch(() => {});
}

function flashBadge(tabId, badge) {
	setBadge(tabId, badge);
	resetTimers.set(tabId, setTimeout(() => {
		resetTimers.delete(tabId);
		setBadge(tabId, BADGES.ready);
	}, 6000));
}

function captureTab(tabId, kind = 'capture') {
	// No frameId: the message reaches every frame, so canvases inside iframes are captured as well
	return api.tabs.sendMessage(tabId, { type: 'webglripper:capture', kind }).catch(() => {});
}

api.runtime.onMessage.addListener((message, sender) => {
	const tabId = sender.tab && sender.tab.id;
	if (tabId === undefined || tabId < 0 || !message)
		return;
	switch (message.type) {
		case 'webglripper:hotkey':
			captureTab(tabId, message.kind === 'pick' ? 'pick' : 'capture');
			break;
		case 'webglripper:contexts':
			if (!resetTimers.has(tabId))
				setBadge(tabId, BADGES.ready);
			break;
		case 'webglripper:state':
			if (message.state === 'done') {
				const meshes = message.result ? message.result.meshes : 0;
				flashBadge(tabId, { text: String(Math.min(meshes, 999)), color: '#2e7d32' });
				rememberRip(message.result, sender);
			} else if (message.state === 'error') {
				flashBadge(tabId, BADGES.error);
			} else if (message.state === 'idle') {
				setBadge(tabId, BADGES.ready); // pick mode or the preview was cancelled
			} else if (BADGES[message.state]) {
				setBadge(tabId, BADGES[message.state]);
			}
			break;
	}
});

if (api.commands) {
	api.commands.onCommand.addListener(async (command, tab) => {
		if (command !== 'capture-frame' && command !== 'pick-object')
			return;
		if (!tab || tab.id === undefined)
			[tab] = await api.tabs.query({ active: true, currentWindow: true });
		if (tab && tab.id !== undefined)
			captureTab(tab.id, command === 'pick-object' ? 'pick' : 'capture');
	});
}

api.runtime.onInstalled.addListener(async ({ reason }) => {
	if (reason !== 'update')
		return;
	// Settings from releases before 1.0 that no longer exist
	try {
		await api.storage.sync.remove(['do_shader_calc', 'minimum_clears']);
	} catch (err) {
		// storage unavailable, nothing to clean up
	}
});
