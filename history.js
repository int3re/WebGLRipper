(async function () {
	'use strict';

	const api = globalThis.browser || globalThis.chrome;
	const $ = (id) => document.getElementById(id);
	const i18n = WebGLRipperI18n;
	const t = (text, values) => i18n.t(text, values);
	const FORMATS = { glb: 'GLB', obj: 'OBJ', both: 'GLB + OBJ', stl: 'STL', usdz: 'USDZ' };
	const THUMBNAIL = /^data:image\/(webp|png);base64,[A-Za-z0-9+/=]+$/;
	const CLEAR_DELAY = 4000;
	// asked for on the first "Show in folder", so installing or updating the extension needs no new permission
	const DOWNLOADS = { permissions: ['downloads', 'downloads.open'] };

	await i18n.load();
	let settings = { ...WEBGLRIPPER_DEFAULTS };
	let clearArmed = null;
	let downloadsAllowed = false;

	function element(tag, className, text) {
		const node = document.createElement(tag);
		if (className)
			node.className = className;
		if (text !== undefined)
			node.textContent = text;
		return node;
	}

	function button(text, title) {
		const node = element('button', '', text);
		node.type = 'button';
		if (title)
			node.title = title;
		return node;
	}

	const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	/* The downloaded file of a rip, if the browser still knows about it. A file saved as "name (1).glb" because the
	 * name was taken matches too. Separate OBJ downloads share a prefix and end with "*" in the history. */
	async function findDownload(entry) {
		if (!downloadsAllowed || !api.downloads || !entry.filename)
			return null;
		const name = String(entry.filename);
		let pattern;
		if (name.endsWith('*')) {
			pattern = `[\\\\/]${escapeRegExp(name.slice(0, -1))}[^\\\\/]*$`;
		} else {
			const dot = name.lastIndexOf('.');
			const stem = dot > 0 ? name.slice(0, dot) : name;
			const extension = dot > 0 ? name.slice(dot) : '';
			pattern = `[\\\\/]${escapeRegExp(stem)}(?: ?\\(\\d+\\))?${escapeRegExp(extension)}$`;
		}
		try {
			const items = await api.downloads.search({ filenameRegex: pattern, orderBy: ['-startTime'], limit: 10 });
			return items.find(item => item.state === 'complete' && item.exists !== false) || null;
		} catch (err) {
			return null;
		}
	}

	function hostOf(url) {
		try {
			return new URL(url).hostname;
		} catch (err) {
			return '';
		}
	}

	function formatTime(time) {
		const date = new Date(time);
		const today = new Date();
		const sameDay = date.toDateString() === today.toDateString();
		const options = sameDay ? { hour: '2-digit', minute: '2-digit' }
			: { day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', hour: '2-digit', minute: '2-digit' };
		const text = new Intl.DateTimeFormat(i18n.language, options).format(date);
		return sameDay ? t('Today, {time}', { time: text }) : text;
	}

	function thumbnail(object) {
		const name = String(object.name || 'mesh');
		const title = [name, i18n.plural(object.triangles, 'triangle|triangles')];
		if (object.texture)
			title.push(t('{size} texture', { size: object.texture }));
		let node;
		if (typeof object.thumbnail === 'string' && THUMBNAIL.test(object.thumbnail)) {
			node = element('img', 'thumb');
			node.alt = name;
			node.src = object.thumbnail;
		} else {
			node = element('span', 'thumb swatch');
			if (/^#[0-9a-f]{6}$/i.test(object.color || ''))
				node.style.background = object.color;
		}
		node.title = title.join(' · ');
		if (object.picked)
			node.classList.add('picked');
		return node;
	}

	function renderEntry(entry) {
		const item = element('li', 'rip');
		item.dataset.id = entry.id;

		const head = element('div', 'rip-head');
		const site = element('div', 'site');
		const url = String(entry.url || '');
		const host = entry.host || hostOf(url) || t('Local page');
		if (/^(https?|file):/i.test(url)) {
			const link = element('a', 'host', host);
			link.href = url;
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
			link.title = url;
			site.append(link);
		} else {
			site.append(element('span', 'host', host));
		}
		if (entry.title)
			site.append(element('span', 'page-title', entry.title));
		const when = element('time', 'when', formatTime(entry.time));
		when.dateTime = new Date(entry.time).toISOString();
		when.title = new Date(entry.time).toLocaleString(i18n.language);
		head.append(site, when);

		const strip = element('div', 'strip');
		const objects = Array.isArray(entry.objects) ? entry.objects : [];
		for (const object of objects)
			strip.append(thumbnail(object));
		const more = (entry.meshes | 0) - objects.length;
		if (more > 0)
			strip.append(element('span', 'thumb more', `+${more}`));

		const facts = [
			i18n.plural(entry.meshes, 'object|objects'),
			entry.textures ? i18n.plural(entry.textures, 'texture|textures') : '',
			FORMATS[entry.format] || ''
		].filter(Boolean).join(' · ');
		const summary = element('div', 'facts', facts);
		const leftOut = i18n.leftOut(entry.leftOut);

		const file = element('div', 'file');
		const several = String(entry.filename).endsWith('*');
		const name = element('code', 'filename', several ? `${String(entry.filename).slice(0, -1)}…` : entry.filename);
		if (several)
			name.title = i18n.plural(entry.files, 'file|files');
		const show = button(t('Show in folder'));
		const open = button(t('Open'), t('Open with the default app'));
		const remove = button('×', t('Remove from history'));
		remove.className = 'remove';
		open.hidden = several;
		file.append(name, show, open, remove);

		item.append(head);
		if (objects.length || more > 0)
			item.append(strip);
		item.append(summary);
		if (leftOut)
			item.append(element('div', 'left-out', leftOut));
		item.append(file);

		remove.addEventListener('click', () => update(history => history.filter(other => other.id !== entry.id)));

		let download = null;
		const missing = () => {
			file.classList.add('missing');
			show.disabled = open.disabled = true;
			show.title = open.title = t('The file was moved or deleted, or the browser\'s download list was cleared.');
		};
		const reveal = () => api.downloads.show(download.id);
		const launch = () => {
			try {
				const opened = api.downloads.open(download.id); // needs the click: no awaiting before this
				if (opened && typeof opened.catch === 'function')
					opened.catch(reveal);
			} catch (err) {
				reveal();
			}
		};
		/* The first click asks for the downloads permission (it has to be asked right in the click), then finds
		 * the file. Opening it needs a click of its own after that, so the second step only shows it. */
		const act = (action) => {
			if (download) {
				action();
				return;
			}
			api.permissions.request(DOWNLOADS).then(async (granted) => {
				if (!granted)
					return;
				downloadsAllowed = true;
				download = await findDownload(entry);
				if (!download)
					missing();
				else
					reveal();
			}, () => {});
		};
		show.addEventListener('click', () => act(reveal));
		open.addEventListener('click', () => act(launch));
		if (downloadsAllowed) {
			findDownload(entry).then(found => {
				download = found;
				if (!found)
					missing();
				else
					name.title = found.filename;
			});
		}
		return item;
	}

	async function update(change) {
		const { history = [] } = await api.storage.local.get('history');
		await api.storage.local.set({ history: change(history) });
	}

	async function render() {
		const { history = [] } = await api.storage.local.get('history').catch(() => ({}));
		const entries = Array.isArray(history) ? history : [];
		$('summary').textContent = entries.length ? i18n.plural(entries.length, 'rip|rips') : '';
		$('clear').hidden = entries.length === 0;
		$('disabled').hidden = settings.keep_history !== false;
		$('empty').hidden = entries.length > 0 || settings.keep_history === false;
		$('empty-hint').textContent = settings.capture_hotkey
			? t('Press {hotkey} on a page with 3D content, or use the toolbar button.', { hotkey: WebGLRipperHotkey.label(settings.capture_hotkey) })
			: t('Use the toolbar button on a page with 3D content.');
		$('rips').replaceChildren(...entries.map(renderEntry));
	}

	async function loadSettings() {
		settings = await api.storage.sync.get(WEBGLRIPPER_DEFAULTS).catch(() => ({ ...WEBGLRIPPER_DEFAULTS }));
	}

	$('clear').addEventListener('click', () => {
		if (!clearArmed) {
			$('clear').textContent = t('Click again to clear');
			$('clear').classList.add('danger');
			clearArmed = setTimeout(() => {
				clearArmed = null;
				$('clear').textContent = t('Clear history');
				$('clear').classList.remove('danger');
			}, CLEAR_DELAY);
			return;
		}
		clearTimeout(clearArmed);
		clearArmed = null;
		$('clear').textContent = t('Clear history');
		$('clear').classList.remove('danger');
		api.storage.local.set({ history: [] });
	});
	$('open-options').addEventListener('click', (event) => {
		event.preventDefault();
		api.runtime.openOptionsPage();
	});

	api.storage.onChanged.addListener(async (changes, area) => {
		if (area === 'local' && changes.history) {
			render();
		} else if (area === 'sync') {
			await loadSettings();
			if (changes.language) {
				i18n.use(settings.language);
				i18n.translate(document);
			}
			render();
		}
	});

	downloadsAllowed = await api.permissions.contains(DOWNLOADS).catch(() => false);
	await loadSettings();
	render();
})();
