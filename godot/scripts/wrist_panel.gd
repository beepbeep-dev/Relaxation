extends Node3D

## The in-headset graphics panel, ported from src/ui/wrist.js.
##
## A slab strapped to the left wrist. You aim the right controller at it and
## pull the trigger; ranges are split down the middle, so tapping the left
## half decreases and the right half increases.
##
## Two decisions here are direct fixes for a real, reported usability
## failure in the WebXR build, and both are worth keeping:
##
##  1. **Rows are tall (7cm at panel scale, not 4).** A 6DoF pointer at
##     arm's length has roughly a degree of jitter. The first version's
##     short rows meant a shaking hand slid between them and it was
##     genuinely hard to hit the setting you meant.
##
##  2. **Two big tap targets instead of a slider.** Fine dragging with a
##     6DoF pointer is miserable; a two-target tap is reliable even with
##     unsteady hands. Coarser on purpose.
##
## The panel also has to own the trigger while it is open. In the WebXR
## build the grip both raised the panel *and* was the leave-the-game button,
## so opening settings inside a minigame dumped you back to the plaza at the
## same moment. Whatever drives input checks `visible` before acting on a
## trigger.

const PANEL_W := 0.26
const PANEL_H := 0.32
const ROW_H := 0.07     ## metres — see note 1 above
const ROW_TOP := 0.055

class Row:
	var key: String
	var label: String
	var kind: String     # "range" | "bool"
	var min_value := 0.0
	var max_value := 1.0
	var step := 0.1

	func _init(k: String, l: String, kd: String, mn := 0.0, mx := 1.0, st := 0.1) -> void:
		key = k
		label = l
		kind = kd
		min_value = mn
		max_value = mx
		step = st

var rows: Array[Row] = []
var values := {}

var _panel: MeshInstance3D
var _label_nodes: Array[Label3D] = []
var _cursor: MeshInstance3D

signal setting_changed(key: String, value: Variant)


func _ready() -> void:
	rows = [
		Row.new("render_scale", "Render scale", "range", 0.6, 1.4, 0.05),
		Row.new("shadows", "Shadows", "bool"),
		Row.new("glow", "Glow", "range", 0.0, 1.6, 0.1),
		Row.new("fog", "Fog", "range", 0.0, 0.012, 0.001),
	]
	values = {
		"render_scale": 1.0,
		"shadows": true,
		"glow": 1.0,
		"fog": 0.005,
	}
	_build()
	visible = false


func _build() -> void:
	var back := StandardMaterial3D.new()
	back.albedo_color = Color(0.04, 0.05, 0.10, 0.92)
	back.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	# Unshaded: a UI slab that takes the scene's lighting goes dark exactly
	# when the player most needs to read it — standing in shadow.
	back.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED

	_panel = MeshInstance3D.new()
	var quad := QuadMesh.new()
	quad.size = Vector2(PANEL_W, PANEL_H)
	quad.material = back
	_panel.mesh = quad
	add_child(_panel)

	var title := Label3D.new()
	title.text = "GRAPHICS"
	title.font_size = 28
	title.pixel_size = 0.0006
	title.modulate = Palette.ACCENT_GREEN
	title.position = Vector3(0, PANEL_H / 2.0 - 0.025, 0.001)
	title.billboard = BaseMaterial3D.BILLBOARD_DISABLED
	_panel.add_child(title)

	for i in rows.size():
		var label := Label3D.new()
		label.font_size = 22
		label.pixel_size = 0.0006
		label.position = Vector3(0, _row_y(i), 0.001)
		label.billboard = BaseMaterial3D.BILLBOARD_DISABLED
		_panel.add_child(label)
		_label_nodes.append(label)

	# A visible cursor. Without one the player cannot tell whether the
	# pointer is on the panel at all, which turns a missed tap into "the
	# panel is broken" rather than "aim slightly higher".
	var cur_mat := StandardMaterial3D.new()
	cur_mat.albedo_color = Palette.ACCENT_GREEN
	cur_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_cursor = MeshInstance3D.new()
	var cur_mesh := SphereMesh.new()
	cur_mesh.radius = 0.006
	cur_mesh.height = 0.012
	cur_mesh.radial_segments = 8
	cur_mesh.rings = 4
	cur_mesh.material = cur_mat
	_cursor.mesh = cur_mesh
	_cursor.visible = false
	_panel.add_child(_cursor)

	_refresh()


func _row_y(i: int) -> float:
	return PANEL_H / 2.0 - ROW_TOP - float(i) * ROW_H - ROW_H / 2.0


func _refresh() -> void:
	for i in rows.size():
		var r: Row = rows[i]
		var v = values[r.key]
		var shown := ""
		if r.kind == "bool":
			shown = "ON" if v else "OFF"
		elif r.step < 0.01:
			shown = "%.3f" % v
		else:
			shown = "%.2f" % v
		_label_nodes[i].text = "%s   %s" % [r.label, shown]


func toggle() -> void:
	visible = not visible
	if not visible:
		_cursor.visible = false


## Point at the panel. `from`/`dir` are a world-space ray, normally the right
## controller's aim. Returns true if the ray is on the panel, which is also
## what tells the caller the panel owns this trigger press.
func aim(from: Vector3, dir: Vector3) -> bool:
	if not visible:
		return false
	var local_from: Vector3 = _panel.to_local(from)
	var local_dir: Vector3 = _panel.global_transform.basis.inverse() * dir
	if absf(local_dir.z) < 1e-6:
		_cursor.visible = false
		return false

	var t := -local_from.z / local_dir.z
	if t < 0.0:
		_cursor.visible = false
		return false
	var hit := local_from + local_dir * t
	if absf(hit.x) > PANEL_W / 2.0 or absf(hit.y) > PANEL_H / 2.0:
		_cursor.visible = false
		return false

	_cursor.position = Vector3(hit.x, hit.y, 0.002)
	_cursor.visible = true
	return true


## Act on a trigger press at the current cursor position.
func press() -> void:
	if not visible or not _cursor.visible:
		return
	var hit := _cursor.position
	var index := int(floor((PANEL_H / 2.0 - ROW_TOP - hit.y) / ROW_H))
	if index < 0 or index >= rows.size():
		return

	var r: Row = rows[index]
	if r.kind == "bool":
		values[r.key] = not values[r.key]
	else:
		# Left half decreases, right half increases — two large targets
		# rather than a slider, see note 2 at the top.
		var dir := 1.0 if hit.x > 0.0 else -1.0
		values[r.key] = clampf(values[r.key] + dir * r.step, r.min_value, r.max_value)

	_refresh()
	setting_changed.emit(r.key, values[r.key])
