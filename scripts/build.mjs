#!/usr/bin/env node
/*
 * Packages the extension for release:
 *
 *   dist/chrome/                        unpacked extension for Chrome, Edge, Brave, Opera
 *   dist/firefox/                       unpacked extension for Firefox
 *   dist/webglripper-<version>-chrome.zip
 *   dist/webglripper-<version>-firefox.zip
 *
 *   node scripts/build.mjs
 *
 * The manifest in the repository declares the background script both ways so the source folder can be loaded in
 * either browser; each package keeps only the variant its browser supports, so neither shows manifest warnings.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const FILES = [
	'manifest.json',
	'webglripper.js',
	'viewer.js',
	'bridge.js',
	'settings.js',
	'i18n.js',
	'background.js',
	'popup.html',
	'popup.js',
	'options.html',
	'options.js',
	'history.html',
	'history.js',
	'ui.css',
	'icons/icon16.png',
	'icons/icon32.png',
	'icons/icon48.png',
	'icons/icon128.png',
	'_locales/en/messages.json',
	'_locales/ru/messages.json',
	'LICENSE',
	'README.md',
	'CHANGELOG.md'
];

const TARGETS = {
	chrome(manifest) {
		delete manifest.background.scripts;
		delete manifest.browser_specific_settings;
	},
	firefox(manifest) {
		delete manifest.background.service_worker;
		delete manifest.minimum_chrome_version;
	}
};

// Fixed timestamp so identical sources produce identical archives
const DOS_TIME = 0;
const DOS_DATE = (46 << 9) | (1 << 5) | 1; // 2026-01-01

function zip(entries) {
	const parts = [];
	const directory = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const deflated = zlib.deflateRawSync(data, { level: 9 });
		const useDeflate = deflated.length < data.length;
		const stored = useDeflate ? deflated : data;
		const crc = zlib.crc32(data);
		const nameBytes = Buffer.from(name, 'utf8');

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034B50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(useDeflate ? 8 : 0, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(stored.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		parts.push(local, nameBytes, stored);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014B50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(useDeflate ? 8 : 0, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(stored.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		directory.push(central, nameBytes);

		offset += local.length + nameBytes.length + stored.length;
	}
	const directorySize = directory.reduce((sum, b) => sum + b.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054B50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directorySize, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, ...directory, end]);
}

/* Builds every target; returns { chrome: { dir, zip }, firefox: { dir, zip } }. */
export function build({ quiet = false } = {}) {
	const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
	const referenced = [
		...source.content_scripts.flatMap(script => script.js),
		source.background.service_worker,
		...source.background.scripts,
		source.action.default_popup,
		source.options_ui.page,
		...Object.values(source.icons)
	];
	for (const file of referenced) {
		if (!FILES.includes(file))
			throw new Error(`manifest.json references ${file}, which is not packaged`);
	}

	const outputs = {};
	for (const [target, adjust] of Object.entries(TARGETS)) {
		const manifest = structuredClone(source);
		adjust(manifest);
		const entries = FILES.map(name => [name, name === 'manifest.json'
			? Buffer.from(JSON.stringify(manifest, null, '\t') + '\n')
			: fs.readFileSync(path.join(ROOT, name))]);

		const dir = path.join(DIST, target);
		fs.rmSync(dir, { recursive: true, force: true });
		for (const [name, data] of entries) {
			fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
			fs.writeFileSync(path.join(dir, name), data);
		}
		const zipFile = path.join(DIST, `webglripper-${source.version}-${target}.zip`);
		fs.writeFileSync(zipFile, zip(entries));
		outputs[target] = { dir, zip: zipFile };
		if (!quiet)
			console.log(`${path.relative(ROOT, zipFile)}  (${entries.length} files, ${fs.statSync(zipFile).size} bytes)`);
	}
	return outputs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	build();
