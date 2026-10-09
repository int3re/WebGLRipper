(async function () {
	'use strict';

	const api = globalThis.browser || globalThis.chrome;
	const $ = (id) => document.getElementById(id);
	const CHECKBOXES = ['skip_duplicates', 'skip_overlays', 'show_preview', 'should_download_zip', 'do_model_view_matrix',
		'center_model', 'compute_normals', 'export_vertex_colors', 'weld_vertices', 'unflip_textures', 'is_debug_mode',
		'glb_compact', 'export_camera', 'bake_poses', 'keep_history'];
	const SELECTS = ['language', 'export_format', 'export_layout', 'default_texture_res'];
	const i18n = WebGLRipperI18n;
	const t = (text, values) => i18n.t(text, values);
	await i18n.load();
	const HOTKEYS = { capture_hotkey: 'hotkey-record', pick_hotkey: 'pick-hotkey-record' };
	const TEXTS = ['extra_position_names', 'extra_normal_names', 'extra_uv_names', 'extra_texture_names', 'extra_matrix_names'];

	const hotkeys = { capture_hotkey: WEBGLRIPPER_DEFAULTS.capture_hotkey, pick_hotkey: WEBGLRIPPER_DEFAULTS.pick_hotkey };
	let recording = null; // the hotkey setting being recorded
	let savedTimer = 0;

	function flashSaved() {
		$('saved').classList.add('visible');
		clearTimeout(savedTimer);
		savedTimer = setTimeout(() => $('saved').classList.remove('visible'), 1200);
	}

	function save(values) {
		return api.storage.sync.set(values).then(flashSaved);
	}

	function renderHotkeys() {
		for (const [setting, id] of Object.entries(HOTKEYS)) {
			const button = $(id);
			button.classList.toggle('recording', recording === setting);
			button.textContent = recording === setting ? t('Press a key… (Esc to cancel)') : t(WebGLRipperHotkey.label(hotkeys[setting]));
		}
	}

	function fill(items) {
		for (const id of CHECKBOXES)
			$(id).checked = !!items[id];
		for (const id of SELECTS) {
			$(id).value = items[id];
			if ($(id).value !== items[id])
				$(id).value = WEBGLRIPPER_DEFAULTS[id]; // stored value no longer offered
		}
		for (const id of TEXTS)
			$(id).value = items[id] || '';
		hotkeys.capture_hotkey = items.capture_hotkey;
		hotkeys.pick_hotkey = items.pick_hotkey;
		renderHotkeys();
	}

	function load() {
		return api.storage.sync.get(WEBGLRIPPER_DEFAULTS).then(fill);
	}

	for (const id of CHECKBOXES)
		$(id).addEventListener('change', () => save({ [id]: $(id).checked }));
	for (const id of SELECTS)
		$(id).addEventListener('change', () => save({ [id]: $(id).value }));
	function applyLanguage(setting) {
		i18n.use(setting);
		i18n.translate(document);
		$('version').textContent = t('Version {version}', { version: api.runtime.getManifest().version });
		renderHotkeys();
	}
	$('language').addEventListener('change', () => applyLanguage($('language').value));
	for (const id of TEXTS) {
		let timer = 0;
		$(id).addEventListener('input', () => {
			clearTimeout(timer);
			timer = setTimeout(() => save({ [id]: $(id).value.trim() }), 400);
		});
	}

	for (const button of document.querySelectorAll('.hotkey button')) {
		const setting = button.dataset.setting;
		button.addEventListener('click', () => {
			if (button.id.endsWith('-clear')) {
				recording = null;
				hotkeys[setting] = '';
				save({ [setting]: '' });
			} else {
				recording = recording === setting ? null : setting;
			}
			renderHotkeys();
		});
	}
	document.addEventListener('keydown', (event) => {
		if (!recording)
			return;
		event.preventDefault();
		event.stopPropagation();
		if (event.code === 'Escape') {
			recording = null;
			renderHotkeys();
			return;
		}
		const combo = WebGLRipperHotkey.fromEvent(event);
		if (!combo)
			return; // only a modifier so far
		const setting = recording;
		recording = null;
		hotkeys[setting] = combo;
		renderHotkeys();
		save({ [setting]: combo });
	}, true);

	$('reset').addEventListener('click', () => {
		api.storage.sync.clear().then(() => api.storage.sync.set({ ...WEBGLRIPPER_DEFAULTS })).then(load).then(flashSaved)
			.then(() => applyLanguage(WEBGLRIPPER_DEFAULTS.language));
	});

	$('version').textContent = t('Version {version}', { version: api.runtime.getManifest().version });
	load();
})();
