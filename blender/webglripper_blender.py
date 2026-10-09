# WebGL Ripper for Blender: every new rip in the downloads folder opens in Blender by itself.
#
# Install: Edit > Preferences > Add-ons > Install from Disk (Blender 4.2+; "Install..." in older versions),
# choose this file and enable "WebGL Ripper". The panel is in the 3D view sidebar (N), tab "WebGL Ripper".
#
# Watches the folder for files named webglripper_*.glb / .stl / .usdz / .zip (the names WebGL Ripper gives its
# downloads), waits until a download is complete and imports it into a collection of its own. A .zip is unpacked
# next to itself and its model.glb or OBJ files are imported. Files that were already there when watching started
# are left alone; "Import latest rip" imports the newest one on demand.
#
# MIT License, https://github.com/int3re/WebGLRipper

bl_info = {
	"name": "WebGL Ripper",
	"author": "WebGL Ripper contributors",
	"version": (1, 3, 0),
	"blender": (3, 6, 0),
	"location": "3D View > Sidebar > WebGL Ripper",
	"description": "Imports new WebGL Ripper downloads (GLB, STL, USDZ, OBJ zip) automatically",
	"doc_url": "https://github.com/int3re/WebGLRipper/tree/main/blender",
	"tracker_url": "https://github.com/int3re/WebGLRipper/issues",
	"category": "Import-Export",
}

import os
import time
import zipfile

import bpy
from bpy.props import BoolProperty, StringProperty

PREFIX = "webglripper_"
EXTENSIONS = (".glb", ".stl", ".usdz", ".zip")
INTERVAL = 1.5  # seconds between two looks at the folder

# path -> size: what was there already or has been imported; pending: path -> size at the last look
_state = {"seen": {}, "pending": {}, "watching": False, "last": "", "error": ""}


def default_downloads():
	"""The user's downloads folder, also when Windows has it moved elsewhere."""
	if os.name == "nt":
		try:
			import winreg
			key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
			value, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
			winreg.CloseKey(key)
			path = os.path.expandvars(value)
			if os.path.isdir(path):
				return path
		except OSError:
			pass
	return os.path.join(os.path.expanduser("~"), "Downloads")


def preferences(context=None):
	context = context or bpy.context
	addon = context.preferences.addons.get(__name__)
	return addon.preferences if addon else None


def rips(folder):
	"""webglripper_* downloads in the folder: {path: (size, modified)}"""
	found = {}
	try:
		with os.scandir(folder) as entries:
			for entry in entries:
				name = entry.name
				if not name.startswith(PREFIX) or not name.lower().endswith(EXTENSIONS) or not entry.is_file():
					continue
				stat = entry.stat()
				found[entry.path] = (stat.st_size, stat.st_mtime)
	except OSError:
		pass
	return found


def downloading(path):
	"""Browsers write next to the final name until the download is complete."""
	return any(os.path.exists(path + suffix) for suffix in (".part", ".crdownload", ".download"))


def start_watching(folder):
	_state["seen"] = {path: size for path, (size, _) in rips(folder).items()}
	_state["pending"] = {}
	_state["watching"] = True


# ---- import ----------------------------------------------------------------------------------------------------

def _operator(*names):
	for name in names:
		module, _, op = name.partition(".")
		group = getattr(bpy.ops, module, None)
		if group is not None and hasattr(group, op):
			return getattr(group, op)
	raise RuntimeError(f"No importer for {names[0]} (is the add-on that provides it enabled?)")


def _import_obj(path):
	_operator("wm.obj_import", "import_scene.obj")(filepath=path)


def _unpack(path):
	"""Unpacks a .zip next to itself and returns the folder."""
	base = os.path.splitext(path)[0]
	folder = base
	n = 1
	while os.path.exists(folder):
		folder = f"{base}_{n}"
		n += 1
	root = os.path.realpath(folder)
	with zipfile.ZipFile(path) as archive:
		for member in archive.namelist():
			target = os.path.realpath(os.path.join(folder, member))
			if not target.startswith(root + os.sep):
				raise RuntimeError(f"Unsafe path in the zip: {member}")
		archive.extractall(folder)
	return folder


def _import_file(path):
	extension = os.path.splitext(path)[1].lower()
	if extension == ".glb":
		bpy.ops.import_scene.gltf(filepath=path)
	elif extension == ".stl":
		_operator("wm.stl_import", "import_mesh.stl")(filepath=path)
	elif extension == ".usdz":
		bpy.ops.wm.usd_import(filepath=path)
	elif extension == ".zip":
		folder = _unpack(path)
		model = os.path.join(folder, "model.glb")
		scene = os.path.join(folder, "scene.obj")
		if os.path.exists(model):
			bpy.ops.import_scene.gltf(filepath=model)
		elif os.path.exists(scene):
			_import_obj(scene)
		else:
			objs = sorted(name for name in os.listdir(folder) if name.lower().endswith(".obj"))
			if not objs:
				raise RuntimeError("The zip has no model.glb or .obj files")
			for name in objs:
				_import_obj(os.path.join(folder, name))
	else:
		raise RuntimeError(f"Unsupported file: {path}")


def _window_context():
	"""A window (and a 3D view, when there is one) for operators run from a timer."""
	wm = bpy.context.window_manager
	for window in getattr(wm, "windows", []):
		for area in window.screen.areas:
			if area.type == "VIEW_3D":
				region = next((r for r in area.regions if r.type == "WINDOW"), None)
				return {"window": window, "area": area, "region": region}
		return {"window": window}
	return {}


def import_rip(path, context=None):
	"""Imports one rip into a new collection named after the file; returns the new objects."""
	prefs = preferences(context)
	scene = bpy.context.scene
	before = set(bpy.data.objects)
	override = _window_context()
	with bpy.context.temp_override(**override):
		if bpy.ops.object.mode_set.poll():
			bpy.ops.object.mode_set(mode="OBJECT")
		if bpy.ops.object.select_all.poll():
			bpy.ops.object.select_all(action="DESELECT")
		_import_file(path)
	created = [obj for obj in bpy.data.objects if obj not in before]

	name = os.path.splitext(os.path.basename(path))[0][len(PREFIX):] or "rip"
	collection = bpy.data.collections.new(f"Rip {name}")
	scene.collection.children.link(collection)
	for obj in created:
		for owner in list(obj.users_collection):
			owner.objects.unlink(obj)
		collection.objects.link(obj)
		obj.select_set(True)
	if created:
		bpy.context.view_layer.objects.active = created[0]

	camera = next((obj for obj in created if obj.type == "CAMERA"), None)
	if camera and (scene.camera is None or (prefs and prefs.use_page_camera)):
		scene.camera = camera
	if prefs is None or prefs.frame_imported:
		frame(override)
	_state["last"] = os.path.basename(path)
	_state["error"] = ""
	print(f"[WebGL Ripper] Imported {path}: {len(created)} objects")
	return created


def frame(override):
	if "area" not in override:
		return
	try:
		with bpy.context.temp_override(**override):
			bpy.ops.view3d.view_selected(use_all_regions=False)
	except Exception:
		pass  # nothing selected or no 3D view


def scan():
	"""One look at the folder: imports downloads that are new and complete. Returns what was imported."""
	prefs = preferences()
	if prefs is None:
		return []
	folder = bpy.path.abspath(prefs.watch_folder) or default_downloads()
	if not _state["watching"]:
		start_watching(folder)
		return []
	imported = []
	current = rips(folder)
	for path, (size, _) in sorted(current.items(), key=lambda item: item[1][1]):
		if path in _state["seen"] or size == 0 or downloading(path):
			continue
		# a download is complete when its size stays the same between two looks
		if _state["pending"].get(path) != size:
			_state["pending"][path] = size
			continue
		_state["pending"].pop(path, None)
		_state["seen"][path] = size
		try:
			import_rip(path)
			imported.append(path)
		except Exception as err:
			_state["error"] = f"{os.path.basename(path)}: {err}"
			print(f"[WebGL Ripper] Could not import {path}: {err}")
	return imported


def _timer():
	prefs = preferences()
	if prefs is None:
		return None  # the add-on was disabled
	if prefs.auto_import:
		scan()
	else:
		_state["watching"] = False
	return INTERVAL


# ---- interface -------------------------------------------------------------------------------------------------

def _folder_changed(self, context):
	_state["watching"] = False  # start over: what is in the new folder now counts as old


class WEBGLRIPPER_Preferences(bpy.types.AddonPreferences):
	bl_idname = __name__

	auto_import: BoolProperty(
		name="Import new rips automatically", default=True, update=_folder_changed,
		description="Watch the folder and import every new WebGL Ripper download")
	watch_folder: StringProperty(
		name="Folder", subtype="DIR_PATH", default=default_downloads(), update=_folder_changed,
		description="Where the browser saves downloads")
	frame_imported: BoolProperty(
		name="Frame imported objects", default=True,
		description="Zoom the 3D view to what was imported")
	use_page_camera: BoolProperty(
		name="Use the page's camera", default=False,
		description="Make the camera saved with a GLB the scene camera (otherwise only when the scene has none)")

	def draw(self, context):
		layout = self.layout
		layout.prop(self, "auto_import")
		layout.prop(self, "watch_folder")
		layout.prop(self, "frame_imported")
		layout.prop(self, "use_page_camera")


class WEBGLRIPPER_OT_import_latest(bpy.types.Operator):
	"""Import the newest WebGL Ripper download from the folder"""
	bl_idname = "webglripper.import_latest"
	bl_label = "Import latest rip"
	bl_options = {"REGISTER", "UNDO"}

	def execute(self, context):
		prefs = preferences(context)
		folder = bpy.path.abspath(prefs.watch_folder) or default_downloads()
		found = {path: info for path, info in rips(folder).items() if not downloading(path)}
		if not found:
			self.report({"WARNING"}, f"No webglripper_* files in {folder}")
			return {"CANCELLED"}
		path = max(found, key=lambda p: found[p][1])
		try:
			created = import_rip(path, context)
		except Exception as err:
			self.report({"ERROR"}, f"Could not import {os.path.basename(path)}: {err}")
			return {"CANCELLED"}
		_state["seen"][path] = found[path][0]
		self.report({"INFO"}, f"Imported {os.path.basename(path)} ({len(created)} objects)")
		return {"FINISHED"}


class WEBGLRIPPER_OT_open_folder(bpy.types.Operator):
	"""Open the watched folder"""
	bl_idname = "webglripper.open_folder"
	bl_label = "Open folder"

	def execute(self, context):
		prefs = preferences(context)
		bpy.ops.wm.path_open(filepath=bpy.path.abspath(prefs.watch_folder) or default_downloads())
		return {"FINISHED"}


class WEBGLRIPPER_PT_panel(bpy.types.Panel):
	bl_label = "WebGL Ripper"
	bl_space_type = "VIEW_3D"
	bl_region_type = "UI"
	bl_category = "WebGL Ripper"

	def draw(self, context):
		prefs = preferences(context)
		layout = self.layout
		if prefs is None:
			return
		layout.prop(prefs, "auto_import", text="Import new rips")
		layout.prop(prefs, "watch_folder", text="")
		row = layout.row(align=True)
		row.operator("webglripper.import_latest", icon="IMPORT")
		row.operator("webglripper.open_folder", text="", icon="FILE_FOLDER")
		if _state["last"]:
			layout.label(text=f"Last: {_state['last']}", icon="CHECKMARK")
		if _state["error"]:
			layout.label(text=_state["error"], icon="ERROR")
		elif prefs.auto_import:
			layout.label(text="Waiting for new downloads…", icon="TIME")


CLASSES = (WEBGLRIPPER_Preferences, WEBGLRIPPER_OT_import_latest, WEBGLRIPPER_OT_open_folder, WEBGLRIPPER_PT_panel)


def register():
	for cls in CLASSES:
		bpy.utils.register_class(cls)
	_state["watching"] = False
	if not bpy.app.timers.is_registered(_timer):
		bpy.app.timers.register(_timer, first_interval=INTERVAL, persistent=True)


def unregister():
	if bpy.app.timers.is_registered(_timer):
		bpy.app.timers.unregister(_timer)
	for cls in reversed(CLASSES):
		bpy.utils.unregister_class(cls)


if __name__ == "__main__":
	register()
