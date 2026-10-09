// Shared by the isolated content script and the extension pages: the interface in English or Russian.
// English text is the key; a language maps it to the translation. Plural forms are separated by "|" in the order
// one|few|many (the last form also covers "other"). bridge.js hands the same table to the page engine.
'use strict';

const WEBGLRIPPER_LOCALES = {
	ru: {
		// counted words
		'object|objects': 'объект|объекта|объектов',
		'smaller object|smaller objects': 'объект поменьше|объекта поменьше|объектов поменьше',
		'texture|textures': 'текстура|текстуры|текстур',
		'triangle|triangles': 'треугольник|треугольника|треугольников',
		'mesh|meshes': 'меш|меша|мешей',
		'draw call|draw calls': 'вызов отрисовки|вызова отрисовки|вызовов отрисовки',
		'file|files': 'файл|файла|файлов',
		'rip|rips': 'рип|рипа|рипов',
		'WebGL canvas|WebGL canvases': 'WebGL-холст|WebGL-холста|WebGL-холстов',
		'gizmo part|gizmo parts': 'часть гизмо|части гизмо|частей гизмо',
		'corner helper|corner helpers': 'индикатор осей|индикатора осей|индикаторов осей',
		'full-screen pass|full-screen passes': 'полноэкранный проход|полноэкранных прохода|полноэкранных проходов',
		'shadow/depth copy|shadow/depth copies': 'копия для теней/глубины|копии для теней/глубины|копий для теней/глубины',
		'background|backgrounds': 'фон|фона|фонов',
		'unselected mesh|unselected meshes': 'невыбранный меш|невыбранных меша|невыбранных мешей',
		'Left out: {list}': 'Не вошло: {list}',
		'{size} texture': 'текстура {size}',
		'Not set': 'Не задана',

		// popup
		'Looking for WebGL content…': 'Ищу WebGL-контент…',
		'On this page': 'На странице',
		'Rip next frame': 'Захватить кадр',
		'Pick object': 'Выбрать объект',
		'Click an object in the page to rip only that object': 'Щёлкните объект на странице, чтобы сохранить только его',
		'Last rip': 'Последний рип',
		'Rip': 'Захват',
		'Pick': 'Выбор',
		'History': 'История',
		'Options': 'Настройки',
		'In a frame from {host}': 'Во фрейме с {host}',
		'To rip local files, enable "Allow access to file URLs" in the extension details, then reload this tab.':
			'Чтобы сохранять модели из локальных файлов, включите «Разрешить доступ к URL файлов» в сведениях о расширении и перезагрузите вкладку.',
		'This tab was opened before WebGL Ripper was installed or updated. Reload it to start ripping.':
			'Эта вкладка открыта до установки или обновления WebGL Ripper. Перезагрузите её, чтобы начать.',
		'Reload tab': 'Перезагрузить вкладку',
		'WebGL Ripper can\'t run on this page.': 'WebGL Ripper не может работать на этой странице.',
		'Working…': 'Работаю…',
		'{canvases} found. Ready to rip.': 'Найдено: {canvases}. Можно захватывать.',
		'No WebGL content detected on this page yet.': 'На этой странице пока нет WebGL-контента.',
		'Starting capture…': 'Запускаю захват…',

		// page engine
		'Reading texture {n} of {total}…': 'Читаю текстуру {n} из {total}…',
		'Compressing texture {n}…': 'Сжимаю текстуру {n}…',
		'Writing mesh {n} of {total}…': 'Записываю меш {n} из {total}…',
		'Building {format}…': 'Собираю {format}…',
		'Packing .zip…': 'Упаковываю .zip…',
		'Packing roughness and metalness…': 'Объединяю карты шероховатости и металличности…',
		'No WebGL content in this frame.': 'В этом фрейме нет WebGL-контента.',
		'This browser is too old: CompressionStream is not supported.': 'Браузер слишком старый: нет поддержки CompressionStream.',
		'Waiting for the next frame…': 'Жду следующий кадр…',
		'Nothing was rendered within 15 seconds. Keep the tab visible and make sure the scene is animating (move the camera if it only renders on demand).':
			'За 15 секунд ничего не отрисовалось. Держите вкладку на виду и проверьте, что сцена обновляется (подвигайте камеру, если она рисует только по требованию).',
		'Recording a frame…': 'Записываю кадр…',
		'Recorded {meshes} from {draws}…': 'Записано: {meshes} из {draws}…',
		'Choose what to keep in the page, then press Download.': 'Выберите на странице, что оставить, и нажмите «Скачать».',
		'Cancelled, nothing was downloaded.': 'Отменено, ничего не скачано.',
		'Saved {meshes} and {textures}.': 'Сохранено: {meshes} и {textures}.',
		'Saved {meshes} and {textures} ({failed} could not be read).': 'Сохранено: {meshes} и {textures} (не удалось прочитать: {failedCount}).',
		'Export failed: {error}': 'Экспорт не удался: {error}',
		'Pick mode ended.': 'Режим выбора завершён.',
		'Pick mode cancelled.': 'Режим выбора отменён.',
		'Click the object you want to rip in the page.': 'Щёлкните на странице объект, который нужно сохранить.',
		'Click the object you want to rip · Esc to cancel': 'Щёлкните объект, который нужно сохранить · Esc — отмена',
		'The texture could not be read.': 'Не удалось прочитать текстуру.',
		'The capture is too large for a .zip file (4 GB / 65535 files). Turn off "Download OBJ as ZIP" in the options.':
			'Захват слишком велик для .zip (4 ГБ / 65535 файлов). Отключите «Скачивать OBJ как ZIP» в настройках.',
		'Nothing was found under the cursor. Click on a solid part of the object (not its outline).':
			'Под курсором ничего не найдено. Щёлкните по сплошной части объекта (не по контуру).',
		'No triangle meshes were found in {draws}.': 'Треугольных мешей не найдено (вызовов отрисовки: {drawCount}).',
		'Unrecognized vertex attributes: {sample}. Add the position attribute name under Options → Advanced.':
			'Нераспознанные атрибуты вершин: {sample}. Добавьте имя атрибута позиции в «Настройки → Дополнительно».',

		// preview
		'{count} tris': '{count} треуг.',
		'WebGL Ripper · Preview': 'WebGL Ripper · Предпросмотр',
		'Drag to orbit · right-drag or Shift-drag to pan · wheel to zoom · click a mesh to include or exclude it · double-click to frame':
			'Тяните — вращение · правая кнопка или Shift — сдвиг · колесо — масштаб · щелчок по мешу — включить или исключить · двойной щелчок — в кадр',
		'{meshes} from {page}': '{meshes} со страницы {page}',
		'All': 'Все',
		'None': 'Ничего',
		'Invert': 'Инверсия',
		'Frame': 'В кадр',
		'Video': 'Видео',
		'Record a 360° turntable of the selected meshes as a WebM video (V)': 'Записать облёт выбранных мешей на 360° в видео WebM (V)',
		'Format': 'Формат',
		'One file with textures and materials': 'Один файл с текстурами и материалами',
		'OBJ, MTL and PNG files': 'Файлы OBJ, MTL и PNG',
		'Both': 'Оба',
		'For 3D printing: geometry only': 'Для 3D-печати: только геометрия',
		'For augmented reality on iPhone and iPad': 'Для дополненной реальности на iPhone и iPad',
		'Smaller GLB (compressed geometry, JPEG textures)': 'Лёгкий GLB (сжатая геометрия, текстуры JPEG)',
		'Cancel': 'Отмена',
		'Download': 'Скачать',
		'Download {n}': 'Скачать {n}',
		'3D preview is not available in this browser. The list still works.': '3D-просмотр недоступен в этом браузере. Список всё равно работает.',
		'{selected} selected · {triangles}': 'Выбрано: {selected} · {triangles}',
		'● {left} s': '● {left} с',
		'picked': 'выбран',
		'background': 'фон',

		// options
		'WebGL Ripper Options': 'Настройки WebGL Ripper',
		'Version {version}': 'Версия {version}',
		'Interface': 'Интерфейс',
		'Language': 'Язык',
		'The language of the popup, the preview and these settings.': 'Язык всплывающего окна, предпросмотра и этих настроек.',
		'Automatic (browser language)': 'Автоматически (язык браузера)',
		'Keep a history of rips': 'Вести историю рипов',
		'Remembers what you ripped and where, with thumbnails. Stored only in this browser.':
			'Запоминает, что и откуда вы сохранили, с миниатюрами. Хранится только в этом браузере.',
		'Open history': 'Открыть историю',
		'Capture': 'Захват',
		'Hotkey': 'Горячая клавиша',
		'Rips the next frame of the current tab. You can also use the toolbar button.':
			'Захватывает следующий кадр текущей вкладки. Можно также нажать кнопку на панели инструментов.',
		'Pick hotkey': 'Клавиша выбора объекта',
		'The next click on the page rips only the object under the cursor.': 'Следующий щелчок на странице сохранит только объект под курсором.',
		'Disable the hotkey': 'Отключить клавишу',
		'Press a key… (Esc to cancel)': 'Нажмите клавишу… (Esc — отмена)',
		'Preview before download': 'Предпросмотр перед скачиванием',
		'Shows what was captured in the page: turn it around and choose the meshes to keep.':
			'Показывает захваченное прямо на странице: покрутите модель и выберите, какие меши оставить.',
		'Skip duplicate draws': 'Пропускать повторные отрисовки',
		'Ignores geometry drawn again by depth or shadow passes.': 'Игнорирует геометрию, повторно нарисованную проходами глубины или теней.',
		'Skip viewer overlays': 'Пропускать элементы интерфейса',
		'Ignores axis gizmos and other helpers drawn in a small viewport, and post-processing passes.':
			'Игнорирует гизмо осей и другие помощники в маленьком вьюпорте, а также проходы постобработки.',
		'Characters in their current pose': 'Персонажи в текущей позе',
		'Saves animated characters as they are on the page, not in the T-pose (WebGL 2 pages).':
			'Сохраняет анимированных персонажей такими, как они выглядят на странице, а не в T-позе (страницы на WebGL 2).',
		'Output': 'Вывод',
		'GLB is one file with textures and PBR materials; OBJ is the classic OBJ + MTL + PNG set.':
			'GLB — один файл с текстурами и PBR-материалами; OBJ — классический набор OBJ + MTL + PNG.',
		'STL (3D printing)': 'STL (3D-печать)',
		'USDZ (AR on iPhone)': 'USDZ (AR на iPhone)',
		'Smaller GLB': 'Лёгкий GLB',
		'Compressed geometry and JPEG textures: often several times smaller. Objects import with a scale.':
			'Сжатая геометрия и текстуры JPEG: файл часто в разы меньше. Объекты импортируются с масштабом.',
		'Include the page\'s camera': 'Добавлять камеру страницы',
		'Adds the camera the page used to GLB files, so Blender opens the same view.':
			'Добавляет в GLB камеру, которой пользовалась страница, чтобы в Blender открывался тот же вид.',
		'Open rips in Blender': 'Открывать рипы в Blender',
		'The free add-on imports every new rip into Blender as soon as it is downloaded.':
			'Бесплатный аддон импортирует каждый новый рип в Blender сразу после скачивания.',
		'Get the add-on': 'Скачать аддон',
		'Download OBJ as ZIP': 'Скачивать OBJ как ZIP',
		'One file per capture. Otherwise every model and texture is a separate download.':
			'Один файл на захват. Иначе каждая модель и текстура скачиваются отдельно.',
		'OBJ layout': 'Раскладка OBJ',
		'Separate files per mesh, a single scene.obj, or both.': 'Отдельный файл на каждый меш, один scene.obj или оба варианта.',
		'One OBJ per mesh': 'Один OBJ на меш',
		'One combined scene.obj': 'Один общий scene.obj',
		'Place meshes in the scene': 'Расставлять меши по сцене',
		'Applies the model matrix found in the shader, so objects keep their positions.':
			'Применяет найденную в шейдере матрицу модели, чтобы объекты остались на своих местах.',
		'Move to the origin': 'Переносить в начало координат',
		'Centers the export and stands it on the floor, ready to use in Blender.': 'Центрирует модель и ставит её на пол — сразу готово для Blender.',
		'Smooth normals when missing': 'Сглаженные нормали, если их нет',
		'Computes normals for meshes the page drew without any; hard edges stay hard.':
			'Вычисляет нормали для мешей, нарисованных без них; острые рёбра остаются острыми.',
		'Export vertex colors': 'Экспортировать цвета вершин',
		'Written as "v x y z r g b", supported by Blender and MeshLab.': 'Записываются как «v x y z r g b», их понимают Blender и MeshLab.',
		'Merge duplicate vertices': 'Объединять одинаковые вершины',
		'Reconnects triangles that the page drew as separate vertices: smaller files, editable meshes.':
			'Соединяет треугольники, нарисованные отдельными вершинами: файлы меньше, меши удобно редактировать.',
		'Textures': 'Текстуры',
		'Unflip textures': 'Переворачивать текстуры',
		'WebGL stores images bottom-up; keep this on for correct UV mapping in OBJ viewers.':
			'WebGL хранит изображения снизу вверх; оставьте включённым для правильной UV-развёртки в просмотрщиках OBJ.',
		'Fallback texture size': 'Запасной размер текстуры',
		'Only used when the real size of a texture could not be detected.': 'Используется, только если настоящий размер текстуры определить не удалось.',
		'Advanced': 'Дополнительно',
		'Extra shader names for engines that WebGL Ripper doesn\'t recognize. Comma separated, case insensitive. The':
			'Дополнительные имена из шейдеров для движков, которые WebGL Ripper не распознаёт. Через запятую, регистр не важен. Файл',
		'file inside every ZIP and the debug log list the names a page uses.':
			'в каждом ZIP и отладочный журнал перечисляют имена, которые использует страница.',
		'Position attributes': 'Атрибуты позиции',
		'e.g. in_ATTRIBUTE0': 'например, in_ATTRIBUTE0',
		'Normal attributes': 'Атрибуты нормалей',
		'UV attributes': 'Атрибуты UV',
		'Diffuse texture samplers': 'Сэмплеры диффузной текстуры',
		'Model matrix uniforms': 'Uniform-переменные матрицы модели',
		'Debug logging': 'Отладочный журнал',
		'Prints details about every capture to the page\'s developer console.': 'Выводит подробности каждого захвата в консоль разработчика страницы.',
		'Reset to defaults': 'Сбросить настройки',
		'Saved': 'Сохранено',

		// history
		'WebGL Ripper History': 'История WebGL Ripper',
		'Rip history': 'История рипов',
		'Clear history': 'Очистить историю',
		'Click again to clear': 'Нажмите ещё раз',
		'Nothing ripped yet.': 'Пока ничего не сохранено.',
		'The history is turned off.': 'История отключена.',
		'Press {hotkey} on a page with 3D content, or use the toolbar button.':
			'Нажмите {hotkey} на странице с 3D или кнопку расширения на панели инструментов.',
		'Use the toolbar button on a page with 3D content.': 'Нажмите кнопку расширения на панели инструментов на странице с 3D.',
		'Today, {time}': 'Сегодня, {time}',
		'Local page': 'Локальная страница',
		'Show in folder': 'Показать в папке',
		'Open': 'Открыть',
		'Open with the default app': 'Открыть в программе по умолчанию',
		'Remove from history': 'Удалить из истории',
		'The file was moved or deleted, or the browser\'s download list was cleared.':
			'Файл перемещён или удалён, либо список загрузок браузера очищен.'
	}
};

const WebGLRipperI18n = {
	language: 'en',
	strings: null,
	rules: null,

	/* 'auto' follows the browser's interface language */
	resolve(setting) {
		let language = setting && setting !== 'auto' ? String(setting) : '';
		if (!language) {
			const api = globalThis.browser || globalThis.chrome;
			try {
				language = api && api.i18n ? api.i18n.getUILanguage() : '';
			} catch (err) {
				language = '';
			}
			language = language || (typeof navigator !== 'undefined' && navigator.language) || 'en';
		}
		language = language.toLowerCase().split(/[-_]/)[0];
		return WEBGLRIPPER_LOCALES[language] ? language : 'en';
	},

	use(setting) {
		this.language = this.resolve(setting);
		this.strings = WEBGLRIPPER_LOCALES[this.language] || null;
		this.rules = new Intl.PluralRules(this.language);
		return this.language;
	},

	/* What the page engine needs: the language and its table (null for English). */
	locale() {
		return { language: this.language, strings: this.strings };
	},

	t(text, values) {
		let result = this.strings && typeof this.strings[text] === 'string' ? this.strings[text] : text;
		if (values)
			result = result.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
		return result;
	},

	count(n) {
		return Number(n || 0).toLocaleString('en-US').replace(/,/g, ' ');
	},

	/* plural(5, 'object|objects') -> "5 objects" / "5 объектов" */
	plural(n, forms) {
		const list = this.t(forms).split('|');
		const category = this.rules ? this.rules.select(Number(n) || 0) : (n === 1 ? 'one' : 'other');
		const index = category === 'one' ? 0 : category === 'few' ? 1 : category === 'many' ? 2 : list.length - 1;
		return `${this.count(n)} ${list[Math.min(index, list.length - 1)]}`;
	},

	/* "Left out: 2 gizmo parts · 1 background" for a rip's leftOut numbers, or '' */
	leftOut(out) {
		const parts = [
			[out && out.gizmos, 'gizmo part|gizmo parts'], [out && out.corner, 'corner helper|corner helpers'],
			[out && out.passes, 'full-screen pass|full-screen passes'], [out && out.duplicates, 'shadow/depth copy|shadow/depth copies'],
			[out && out.background, 'background|backgrounds'], [out && out.unselected, 'unselected mesh|unselected meshes']
		].filter(([n]) => n > 0).map(([n, forms]) => this.plural(n, forms));
		return parts.length ? this.t('Left out: {list}', { list: parts.join(' · ') }) : '';
	},

	/* Translates the static text of an extension page: text nodes, titles and placeholders whose English text is
	 * in the table. The English original is kept, so the page can switch languages again. */
	translate(root) {
		const document = root.ownerDocument || root;
		document.documentElement.lang = this.language;
		const sources = this.sources || (this.sources = new WeakMap()); // text node -> English text
		const swap = (original) => {
			const [, lead, text, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(original);
			const key = text.replace(/\s+/g, ' ');
			return key ? lead + this.t(key) + trail : original;
		};
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.parentElement || /^(SCRIPT|STYLE|CODE|KBD)$/.test(node.parentElement.tagName))
				continue;
			if (!sources.has(node))
				sources.set(node, node.nodeValue);
			node.nodeValue = swap(sources.get(node));
		}
		for (const [attribute, key] of [['title', 'i18nTitle'], ['placeholder', 'i18nPlaceholder']]) {
			for (const element of root.querySelectorAll(`[${attribute}]`)) {
				if (!(key in element.dataset))
					element.dataset[key] = element.getAttribute(attribute);
				element.setAttribute(attribute, swap(element.dataset[key]));
			}
		}
		document.documentElement.classList.remove('i18n-pending');
	},

	/* For extension pages: reads the language setting and translates the page. */
	async load() {
		const api = globalThis.browser || globalThis.chrome;
		let setting = 'auto';
		try {
			({ language: setting } = await api.storage.sync.get({ language: 'auto' }));
		} catch (err) {
			setting = 'auto';
		}
		this.use(setting);
		if (typeof document !== 'undefined')
			this.translate(document);
		return this.language;
	}
};

WebGLRipperI18n.use('auto');
