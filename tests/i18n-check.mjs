/*
 * Checks the translations in i18n.js against the sources: every English text that the interface shows through
 * t() / tr() / plural() or as static page text must have a translation, with the same {placeholders}, and the
 * table must not keep texts that are no longer used.
 *
 *   node tests/i18n-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* Texts that pass through t() without appearing as a literal next to it. */
const INDIRECT = [
	'Not set', // WebGLRipperHotkey.label() for an empty hotkey
	'One file with textures and materials', 'OBJ, MTL and PNG files', 'Both', 'For 3D printing: geometry only',
	'For augmented reality on iPhone and iPad', // the preview's format tips
	'gizmo part|gizmo parts', 'corner helper|corner helpers', 'full-screen pass|full-screen passes',
	'shadow/depth copy|shadow/depth copies', 'background|backgrounds', 'unselected mesh|unselected meshes' // i18n.leftOut()
];
/* Static page text that stays the same in every language. */
const UNTRANSLATED = new Set(['WebGL Ripper', 'GLB', 'OBJ', 'GLB + OBJ', 'English', 'Русский', 'Insert', 'Shift + Insert', '✕', '·',
	'rip-info.json', '256 × 256', '512 × 512', '1024 × 1024', '2048 × 2048', '4096 × 4096', '8192 × 8192']);

export function checkTranslations() {
	const sandbox = { navigator: { language: 'en' }, Intl, globalThis: {} };
	vm.createContext(sandbox);
	vm.runInContext(`${read('i18n.js')}\nglobalThis.result = { locales: WEBGLRIPPER_LOCALES, i18n: WebGLRipperI18n };`, sandbox);
	const { locales, i18n } = sandbox.globalThis.result;
	const problems = [];
	const used = new Map(); // English text -> where

	const unescape = (text) => text.replace(/\\(.)/g, '$1');
	for (const file of ['popup.js', 'options.js', 'history.js', 'webglripper.js', 'viewer.js', 'i18n.js']) {
		const source = read(file);
		const patterns = [/\b(?:t|tr|i18n\.t)\(\s*'((?:[^'\\]|\\.)+)'/g, /\bplural\([^,()]+(?:\([^()]*\))?[^,()]*,\s*'((?:[^'\\]|\\.)+)'/g];
		for (const pattern of patterns) {
			for (const match of source.matchAll(pattern))
				used.set(unescape(match[1]), file);
		}
	}
	for (const text of INDIRECT)
		used.set(text, 'indirect');
	for (const file of ['popup.html', 'options.html', 'history.html']) {
		const html = read(file).replace(/<(script|style|code|kbd)\b[\s\S]*?<\/\1>/g, '<split>');
		for (const match of html.matchAll(/>([^<]+)</g)) {
			const text = match[1].replace(/\s+/g, ' ').trim();
			if (text && /[A-Za-z]/.test(text) && !UNTRANSLATED.has(text))
				used.set(text.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), file);
		}
		for (const match of html.matchAll(/\s(?:title|placeholder)="([^"]+)"/g))
			used.set(match[1], file);
	}

	const placeholders = (text) => new Set(Array.from(text.matchAll(/\{(\w+)\}/g), m => m[1]));
	for (const [language, table] of Object.entries(locales)) {
		for (const [text, where] of used) {
			if (UNTRANSLATED.has(text))
				continue;
			const translation = table[text];
			if (typeof translation !== 'string') {
				problems.push(`${language}: no translation for "${text}" (${where})`);
				continue;
			}
			const english = placeholders(text);
			for (const name of placeholders(translation)) {
				// a translation may use the extra count values the code passes along (failedCount, drawCount)
				if (!english.has(name) && !/Count$/.test(name))
					problems.push(`${language}: "${text}" uses an unknown placeholder {${name}}`);
			}
			const forms = text.split('|').length;
			if (forms > 1 && translation.split('|').length < 2)
				problems.push(`${language}: "${text}" needs plural forms`);
		}
		for (const text of Object.keys(table)) {
			if (!used.has(text))
				problems.push(`${language}: "${text}" is not used anywhere`);
		}
	}

	// plural forms pick the right word
	i18n.use('ru');
	const samples = [[1, 'объект'], [3, 'объекта'], [5, 'объектов'], [21, 'объект'], [12, 'объектов']];
	for (const [n, word] of samples) {
		if (i18n.plural(n, 'object|objects') !== `${n} ${word}`)
			problems.push(`ru: plural(${n}) gave "${i18n.plural(n, 'object|objects')}"`);
	}
	i18n.use('en');
	if (i18n.plural(1, 'object|objects') !== '1 object' || i18n.plural(2, 'object|objects') !== '2 objects')
		problems.push('en: plural forms are wrong');
	return { problems, texts: used.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { problems, texts } = checkTranslations();
	for (const problem of problems)
		console.log(`  FAIL ${problem}`);
	console.log(problems.length ? `\n${problems.length} problem(s)` : `All ${texts} interface texts are translated`);
	process.exit(problems.length ? 1 : 0);
}
