# WebGL Ripper for Blender

Every model you rip opens in Blender by itself: the add-on watches your downloads folder and imports each new
WebGL Ripper file as soon as the browser has finished saving it.

*[По-русски ниже](#по-русски).*

## Install

1. Download [`webglripper_blender.py`](webglripper_blender.py) (on GitHub: **Download raw file**).
2. In Blender: **Edit → Preferences → Add-ons**, then **Install from Disk…** (Blender 4.2 and newer, in the ⌄ menu
   at the top right) or **Install…** (Blender 3.6 – 4.1). Choose the file.
3. Enable **WebGL Ripper** in the list.

The panel is in the 3D view sidebar: press **N** and open the **WebGL Ripper** tab.

## What it does

- Watches the folder (your downloads folder unless you choose another one) for `webglripper_*.glb`, `.stl`,
  `.usdz` and `.zip` files: the names WebGL Ripper gives its downloads.
- Waits until a download is complete (no `.crdownload` / `.part` file next to it, size no longer changing).
- Imports it into a new collection named after the file, selects it and frames it in the 3D view.
- A `.zip` (OBJ export) is unpacked next to itself; its `model.glb` is imported when there is one, otherwise
  `scene.obj` or every `mesh_*.obj`.
- A GLB saved with the page's camera becomes the scene camera when the scene has none
  (or always, with **Use the page's camera** in the add-on preferences).
- Files that were already in the folder are left alone. **Import latest rip** imports the newest one on demand.

Separate OBJ downloads (with **Download OBJ as ZIP** turned off) are not imported automatically; use
**File → Import → Wavefront (.obj)** for those.

## Options

| Option | Default | |
| --- | --- | --- |
| Import new rips automatically | on | Watch the folder. Turn it off to stop watching. |
| Folder | your downloads folder | Where the browser saves downloads. |
| Frame imported objects | on | Zoom the 3D view to what was imported. |
| Use the page's camera | off | Always make the camera from a GLB the scene camera. |

For Blender 3.6 and newer; tested with Blender 4.5 (`node tests/run-blender.mjs`).

---

## По-русски

Каждая сохранённая модель сама открывается в Blender: аддон следит за папкой загрузок и импортирует каждый новый
файл WebGL Ripper, как только браузер закончил его скачивать.

### Установка

1. Скачайте [`webglripper_blender.py`](webglripper_blender.py) (на GitHub: **Download raw file**).
2. В Blender: **Edit → Preferences → Add-ons**, затем **Install from Disk…** (Blender 4.2 и новее, в меню ⌄
   справа вверху) или **Install…** (Blender 3.6 – 4.1). Выберите файл.
3. Включите **WebGL Ripper** в списке.

Панель — в боковой панели 3D-вида: нажмите **N** и откройте вкладку **WebGL Ripper**.

### Что делает

- Следит за папкой (по умолчанию — ваши «Загрузки») и ищет файлы `webglripper_*.glb`, `.stl`, `.usdz` и `.zip`.
- Ждёт, пока загрузка закончится (рядом нет `.crdownload` / `.part`, размер больше не меняется).
- Импортирует файл в новую коллекцию с именем файла, выделяет и показывает её в 3D-виде.
- `.zip` (экспорт OBJ) распаковывается рядом; импортируется `model.glb`, если он есть, иначе `scene.obj` или все
  `mesh_*.obj`.
- Камера страницы из GLB становится камерой сцены, если в сцене камеры нет (или всегда — с опцией
  **Use the page's camera**).
- Файлы, которые уже лежали в папке, не трогаются. **Import latest rip** импортирует самый новый по кнопке.

Отдельные файлы OBJ (когда **Скачивать OBJ как ZIP** выключено) автоматически не импортируются — откройте их через
**File → Import → Wavefront (.obj)**.
