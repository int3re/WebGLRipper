// Shared by the isolated content script, the popup and the options page.
'use strict';

const WEBGLRIPPER_DEFAULTS = Object.freeze({
	capture_hotkey: 'Insert',          // KeyboardEvent.code, optionally prefixed with Ctrl+/Alt+/Shift+/Meta+
	pick_hotkey: 'Shift+Insert',       // Enters pick mode: the next click on the page rips the object under the cursor
	show_preview: true,                // Show the captured meshes in the page and let the user choose before saving
	export_format: 'glb',              // 'glb' | 'obj' | 'both'
	should_download_zip: true,         // One .zip instead of many separate downloads
	export_layout: 'separate',         // 'separate' | 'combined' | 'both'
	do_model_view_matrix: true,        // Place meshes using the model matrix found in the shader
	center_model: true,                // Move the export to the origin, standing on the floor
	compute_normals: true,             // Smooth normals for meshes drawn without any
	unflip_textures: true,             // Store textures the way OBJ/MTL expects them (origin bottom-left)
	skip_duplicates: true,             // Drop repeated draws of the same geometry (depth/shadow passes)
	skip_overlays: true,               // Drop viewer chrome: gizmos in small viewports, post-processing passes
	weld_vertices: true,               // Merge identical vertices (pages often draw without an index buffer)
	export_vertex_colors: true,        // Write vertex colors as "v x y z r g b"
	default_texture_res: '4096x4096',  // Fallback when a texture's size could not be tracked
	is_debug_mode: false,              // Verbose logging in the page console
	extra_position_names: '',          // Comma separated, for engines with unusual attribute names
	extra_normal_names: '',
	extra_uv_names: '',
	extra_texture_names: '',
	extra_matrix_names: ''
});

const WebGLRipperHotkey = {
	MODIFIERS: ['Ctrl', 'Alt', 'Shift', 'Meta'],
	MODIFIER_CODES: new Set([
		'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
		'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'
	]),

	/* Turns a keydown event into a hotkey string such as "Ctrl+Shift+KeyR", or null for bare modifiers. */
	fromEvent(event) {
		if (!event.code || this.MODIFIER_CODES.has(event.code))
			return null;
		let parts = [];
		if (event.ctrlKey) parts.push('Ctrl');
		if (event.altKey) parts.push('Alt');
		if (event.shiftKey) parts.push('Shift');
		if (event.metaKey) parts.push('Meta');
		parts.push(event.code);
		return parts.join('+');
	},

	matches(event, hotkey) {
		return !!hotkey && this.fromEvent(event) === hotkey;
	},

	hasModifier(hotkey) {
		return this.MODIFIERS.some(m => String(hotkey).startsWith(m + '+'));
	},

	label(hotkey) {
		if (!hotkey)
			return 'None';
		return String(hotkey).split('+').map(part => part
			.replace(/^Key([A-Z])$/, '$1')
			.replace(/^Digit(\d)$/, '$1')
			.replace(/^Numpad(.+)$/, 'Num $1')
			.replace(/^Arrow(.+)$/, '$1 Arrow')
		).join(' + ');
	}
};
