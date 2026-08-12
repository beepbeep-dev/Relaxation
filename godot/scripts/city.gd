extends Node3D

## Kaisei's street level, ported from src/world/city.js.
##
## Two rules govern the whole thing, and both survive every engine change
## because they are properties of the hardware, not the engine:
##
##  1. Draw calls are the budget, not triangles. A tile-based mobile GPU
##     cares far more about how many times you ask it to draw than about how
##     much you draw. Everything repeated goes through a MultiMesh, which is
##     Godot's equivalent of the WebGL build's InstancedMesh and Unity's
##     Graphics.DrawMeshInstanced.
##
##  2. Buildings are composed from stacked boxes, not single scaled cubes. A
##     wider street-level podium, one to three shaft tiers stepping back as
##     they rise, and a crown on the tall ones. Setbacks are what make a
##     skyline read as architecture rather than as a bar chart, and since
##     every box is an instance of one mesh they cost nothing extra.

const BLOCK := 42.0        ## metres between street centrelines
const STREET := 14.0       ## street width
const SEED := 20260811     ## the city is identical on every boot and device

@export var city_blocks: int = 8
@export var prop_density: float = 0.7

var _rng := RandomNumberGenerator.new()
var colliders: Array[AABB] = []

var _tower_mm: MultiMeshInstance3D
var _parapet_mm: MultiMeshInstance3D


func _ready() -> void:
	_rng.seed = SEED
	_generate()


func _block_coord(i: int) -> float:
	return (i - (city_blocks - 1) * 0.5) * BLOCK


func _generate() -> void:
	var parts: Array[Transform3D] = []
	var tints: Array[Color] = []
	var caps: Array[Transform3D] = []

	var keepout := BLOCK * 1.2   # the plaza the player spawns into

	for bx in city_blocks:
		for bz in city_blocks:
			var cx := _block_coord(bx)
			var cz := _block_coord(bz)
			if sqrt(cx * cx + cz * cz) < keepout:
				continue

			var count := 2 + _rng.randi() % 3
			var usable := BLOCK - STREET
			for k in count:
				var w := _rng.randf_range(9.0, usable * 0.55)
				var d := _rng.randf_range(9.0, usable * 0.55)
				var distance := sqrt(cx * cx + cz * cz)
				# Taller towards the horizon, so the playable streets sit
				# inside what reads as a downtown core we never built.
				var h := _rng.randf_range(18.0, 40.0) + distance * 0.45
				var pos := Vector3(
					cx + _rng.randf_range(-1.0, 1.0) * (usable * 0.5 - w * 0.5),
					0.0,
					cz + _rng.randf_range(-1.0, 1.0) * (usable * 0.5 - d * 0.5))
				# Hue restricted to the green->blue->purple arc, so
				# per-building variation never leaves the palette.
				var tint := Color.from_hsv(_rng.randf_range(0.42, 0.75), 0.5,
					_rng.randf_range(0.55, 0.9))
				_decompose(pos, w, d, h, tint, parts, tints, caps)

	_tower_mm = _build_multimesh(parts, tints, _facade_material())
	add_child(_tower_mm)
	_parapet_mm = _build_multimesh(caps, [], _parapet_material())
	add_child(_parapet_mm)


## Split one building into podium, shaft tiers and crown.
func _decompose(pos: Vector3, w: float, d: float, h: float, tint: Color,
		parts: Array[Transform3D], tints: Array[Color], caps: Array[Transform3D]) -> void:
	var podium_h: float = min(7.2, h * 0.28)
	_add_part(parts, tints, pos + Vector3.UP * podium_h * 0.5,
		Vector3(w * 1.14, podium_h, d * 1.14), tint)
	_add_cap(caps, pos + Vector3.UP * podium_h, w * 1.2, d * 1.2)

	var tiers := 1 + _rng.randi() % 3
	var base_y := podium_h
	var remaining := h - podium_h
	var sw := w
	var sd := d

	for i in tiers:
		if remaining <= 3.0:
			break
		var last := i == tiers - 1
		var tier_h := remaining if last else remaining * _rng.randf_range(0.4, 0.7)
		_add_part(parts, tints, pos + Vector3.UP * (base_y + tier_h * 0.5),
			Vector3(sw, tier_h, sd), tint)
		base_y += tier_h
		remaining -= tier_h
		if not last:
			_add_cap(caps, pos + Vector3.UP * base_y, sw * 1.06, sd * 1.06)
			var step := _rng.randf_range(0.72, 0.9)
			sw *= step
			sd *= step

	if h > 34.0:
		var crown_h := _rng.randf_range(2.5, 6.0)
		_add_part(parts, tints, pos + Vector3.UP * (base_y + crown_h * 0.5),
			Vector3(sw * 0.62, crown_h, sd * 0.62), tint)
		base_y += crown_h
	_add_cap(caps, pos + Vector3.UP * base_y, sw * 1.08, sd * 1.08)

	# Collision uses the podium, the widest part at walking height.
	colliders.append(AABB(
		pos - Vector3(w * 1.14, 0.0, d * 1.14) * 0.5,
		Vector3(w * 1.14, podium_h, d * 1.14)))


func _add_part(parts: Array[Transform3D], tints: Array[Color],
		centre: Vector3, size: Vector3, tint: Color) -> void:
	parts.append(Transform3D(Basis().scaled(size), centre))
	tints.append(tint)


## A thin slab overhanging a tier top — the roof's edge.
func _add_cap(caps: Array[Transform3D], at: Vector3, w: float, d: float) -> void:
	caps.append(Transform3D(Basis().scaled(Vector3(w, 0.44, d)), at + Vector3.UP * 0.22))


func _build_multimesh(transforms: Array[Transform3D], tints: Array[Color],
		material: Material) -> MultiMeshInstance3D:
	# Configured through a BoxMesh-typed local, not through `mm.mesh`:
	# MultiMesh.mesh is declared as the base Mesh, which has neither `size`
	# nor `material`, so touching them via that property is a parse error
	# rather than something that surfaces at runtime.
	var box := BoxMesh.new()
	box.size = Vector3.ONE
	box.material = material

	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = not tints.is_empty()
	mm.mesh = box
	mm.instance_count = transforms.size()
	for i in transforms.size():
		mm.set_instance_transform(i, transforms[i])
		if mm.use_colors:
			mm.set_instance_color(i, tints[i])

	var inst := MultiMeshInstance3D.new()
	inst.multimesh = mm
	return inst


func _facade_material() -> Material:
	var mat := ShaderMaterial.new()
	mat.shader = load("res://scripts/facade.gdshader")
	return mat


func _parapet_material() -> Material:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Palette.DARK_METAL
	mat.roughness = 0.38
	mat.metallic = 0.85

	# Brushed metal grain on the roof edges. Near-greyscale albedo, so the
	# palette colour above still decides the hue; the paired normal map is
	# derived from this same image, so its relief matches the visible grain.
	var albedo := load("res://assets/textures/panel.jpg") as Texture2D
	var normal := load("res://assets/textures/panel_n.jpg") as Texture2D
	if albedo:
		mat.albedo_texture = albedo
		mat.uv1_scale = Vector3(3, 3, 1)
	if normal:
		mat.normal_enabled = true
		mat.normal_texture = normal
		mat.normal_scale = 0.5
	return mat
