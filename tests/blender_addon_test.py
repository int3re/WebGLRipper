# Tests the Blender add-on without a user interface:
#
#   blender -b --factory-startup --python tests/blender_addon_test.py -- <folder with plain.glb, stl.stl, usdz.usdz>
#
# Set BLENDER_USER_SCRIPTS to an empty folder first: the add-on is installed there, not into your Blender.
import os
import shutil
import sys
import tempfile
import time
import zipfile

import addon_utils
import bpy

samples = sys.argv[sys.argv.index("--") + 1]
failures = []


def report(name, ok, detail=""):
	print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  —  {detail}" if not ok and detail else ""))
	if not ok:
		failures.append(name)


user_scripts = os.environ.get("BLENDER_USER_SCRIPTS")
assert user_scripts, "set BLENDER_USER_SCRIPTS"
addons = os.path.join(user_scripts, "addons")
os.makedirs(addons, exist_ok=True)
shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "blender", "webglripper_blender.py"),
	os.path.join(addons, "webglripper_blender.py"))
if addons not in sys.path:
	sys.path.append(addons)  # the folder did not exist when Blender started
addon_utils.enable("webglripper_blender", default_set=True)
import webglripper_blender as addon  # noqa: E402

report("add-on enables", addon.preferences() is not None)
report("default folder is the downloads folder", os.path.basename(addon.default_downloads()).lower() in ("downloads", "загрузки") or os.path.isdir(addon.default_downloads()), addon.default_downloads())

for obj in list(bpy.data.objects):  # an empty scene (reading factory settings would disable the add-on)
	bpy.data.objects.remove(obj)
watch = tempfile.mkdtemp(prefix="webglripper-watch-")
shutil.copy(os.path.join(samples, "plain.glb"), os.path.join(watch, "webglripper_old_20261009-060000.glb"))
prefs = addon.preferences()
prefs.watch_folder = watch
prefs.auto_import = True

addon.scan()  # starts watching: what is there now is old
report("files that were already there are left alone", addon.scan() == [] and len(bpy.data.objects) == 0, [o.name for o in bpy.data.objects])

stamp = "127.0.0.1_20261009-070102"
shutil.copy(os.path.join(samples, "plain.glb"), os.path.join(watch, f"webglripper_{stamp}.glb"))
shutil.copy(os.path.join(samples, "stl.stl"), os.path.join(watch, f"webglripper_{stamp}b.stl"))
shutil.copy(os.path.join(samples, "usdz.usdz"), os.path.join(watch, f"webglripper_{stamp}c.usdz"))
with zipfile.ZipFile(os.path.join(watch, f"webglripper_{stamp}d.zip"), "w") as archive:
	archive.writestr("mesh_000.obj", "mtllib mesh_000.mtl\no mesh_000\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nusemtl m\nf 1 2 3\nf 1 3 4\nf 1 4 2\nf 2 4 3\n")
	archive.writestr("mesh_000.mtl", "newmtl m\nKd 0.8 0.2 0.2\n")
	archive.writestr("mesh_001.obj", "o mesh_001\nv 2 0 0\nv 3 0 0\nv 2 1 0\nf 1 2 3\n")
	archive.writestr("rip-info.json", "{}")
with zipfile.ZipFile(os.path.join(watch, f"webglripper_{stamp}e.zip"), "w") as archive:
	archive.write(os.path.join(samples, "plain.glb"), "model.glb")
	archive.writestr("scene.obj", "o ignored\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
partial = os.path.join(watch, f"webglripper_{stamp}f.glb")
shutil.copy(os.path.join(samples, "plain.glb"), partial)
open(partial + ".crdownload", "wb").close()

first = addon.scan()
report("a new download waits one look to be sure it is complete", first == [], first)
imported = [os.path.basename(p) for p in addon.scan()]
report("GLB, STL, USDZ and both kinds of zip are imported", sorted(imported) == sorted(
	f"webglripper_{stamp}{s}" for s in (".glb", "b.stl", "c.usdz", "d.zip", "e.zip")), imported)
report("a download in progress is not imported", f"webglripper_{stamp}f.glb" not in imported)

collections = {c.name: c for c in bpy.context.scene.collection.children if c.name.startswith("Rip ")}
report("each rip gets a collection of its own", sorted(collections) == sorted(
	f"Rip {stamp}{s}" for s in ("", "b", "c", "d", "e")), sorted(collections))


def meshes(name):
	# Blender adds .001 to names that are taken by an earlier import
	return sorted(o.name.split(".")[0] for o in collections[name].all_objects if o.type == "MESH")


report("GLB: its meshes and the page camera", len(meshes(f"Rip {stamp}")) >= 3 and
	any(o.type == "CAMERA" for o in collections[f"Rip {stamp}"].all_objects), [o.name for o in collections[f"Rip {stamp}"].all_objects])
report("the page camera becomes the scene camera", bpy.context.scene.camera is not None and bpy.context.scene.camera.name in collections[f"Rip {stamp}"].all_objects)
report("STL: one mesh", len(meshes(f"Rip {stamp}b")) == 1, meshes(f"Rip {stamp}b"))
report("USDZ: its meshes", len(meshes(f"Rip {stamp}c")) >= 3, meshes(f"Rip {stamp}c"))
report("OBJ zip: every mesh with its material", meshes(f"Rip {stamp}d") == ["mesh_000", "mesh_001"] and
	any(o.active_material is not None for o in collections[f"Rip {stamp}d"].all_objects), meshes(f"Rip {stamp}d"))
report("zip with model.glb: the GLB, not the OBJ", len(meshes(f"Rip {stamp}e")) >= 3 and "ignored" not in meshes(f"Rip {stamp}e"), meshes(f"Rip {stamp}e"))
report("a zip is unpacked next to itself", os.path.isfile(os.path.join(watch, f"webglripper_{stamp}d", "mesh_000.obj")))
report("nothing is imported twice", addon.scan() == [] and addon.scan() == [])

os.remove(partial + ".crdownload")
addon.scan()
report("the finished download follows", [os.path.basename(p) for p in addon.scan()] == [f"webglripper_{stamp}f.glb"])

os.utime(os.path.join(watch, "webglripper_old_20261009-060000.glb"), (time.time() + 60, time.time() + 60))
before = len(bpy.data.objects)
result = bpy.ops.webglripper.import_latest()
report("Import latest rip imports the newest file on demand", result == {"FINISHED"} and len(bpy.data.objects) > before and
	"Rip old_20261009-060000" in [c.name for c in bpy.context.scene.collection.children], result)

prefs.auto_import = False
addon._timer()
report("turning automatic import off stops watching", addon._state["watching"] is False)
addon_utils.disable("webglripper_blender")
shutil.rmtree(watch, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" if failures else "\nAll add-on tests passed")
sys.exit(1 if failures else 0)
