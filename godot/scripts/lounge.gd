extends Node3D

## The chill place: a raised deck above the plaza, ported from
## src/world/lounge.js.
##
## The whole point of the game is that it is somewhere to be, not only
## somewhere to do things. This is the part that has to hold up when a player
## is not playing anything — so it gets seats that face outward at the
## skyline, a ramp instead of stairs, and lanterns that drift.

const DECK_Y := 6.0
const DECK_W := 26.0
const DECK_D := 20.0
const DECK_Z := -30.0

const RAMP_LEN := 24.0
const RAMP_HALF_W := 2.5

## Where a player can sit. Read by whatever handles the seat interaction.
var seats: Array[Vector3] = []

var _lanterns: Array[Node3D] = []
var _lantern_phase: Array[float] = []
var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	_rng.seed = 4242
	_build_deck()
	_build_ramp()
	_build_seating()
	_build_lanterns()


func _deck_material() -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Palette.DECK_WOOD
	mat.roughness = 0.62
	var albedo := load("res://assets/textures/wood.jpg") as Texture2D
	var normal := load("res://assets/textures/wood_n.jpg") as Texture2D
	if albedo:
		mat.albedo_texture = albedo
		mat.uv1_scale = Vector3(6, 6, 1)
	if normal:
		mat.normal_enabled = true
		mat.normal_texture = normal
		mat.normal_scale = 0.6
	return mat


func _build_deck() -> void:
	var deck := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = Vector3(DECK_W, 0.6, DECK_D)
	mesh.material = _deck_material()
	deck.mesh = mesh
	deck.position = Vector3(0, DECK_Y - 0.3, DECK_Z)
	add_child(deck)

	# Columns down to the plaza, so the deck reads as supported rather than
	# floating. Four is enough at this span to look structural.
	var col_mat := StandardMaterial3D.new()
	col_mat.albedo_color = Palette.DARK_METAL
	col_mat.roughness = 0.4
	col_mat.metallic = 0.8

	for sx: float in [-1.0, 1.0]:
		for sz: float in [-1.0, 1.0]:
			var col := MeshInstance3D.new()
			var col_mesh := CylinderMesh.new()
			col_mesh.top_radius = 0.34
			col_mesh.bottom_radius = 0.4
			col_mesh.height = DECK_Y
			col_mesh.radial_segments = 8
			col_mesh.material = col_mat
			col.mesh = col_mesh
			col.position = Vector3(
				sx * (DECK_W / 2.0 - 2.0), DECK_Y / 2.0,
				DECK_Z + sz * (DECK_D / 2.0 - 2.0))
			add_child(col)


func _build_ramp() -> void:
	# A ramp rather than stairs: stair stepping in VR either needs stair
	# collision we do not want to write, or it heaves the player up in
	# discrete jolts. A 14-degree ramp is comfortable and readable.
	var start_z := DECK_Z + DECK_D / 2.0
	var end_z := start_z + RAMP_LEN
	var angle := atan2(DECK_Y, RAMP_LEN)

	var ramp := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = Vector3(5.0, 0.4, sqrt(RAMP_LEN * RAMP_LEN + DECK_Y * DECK_Y))
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Palette.CONCRETE
	mat.roughness = 0.82
	var albedo := load("res://assets/textures/concrete.jpg") as Texture2D
	if albedo:
		mat.albedo_texture = albedo
		mat.uv1_scale = Vector3(4, 4, 1)
	mesh.material = mat
	ramp.mesh = mesh
	ramp.position = Vector3(0, DECK_Y / 2.0, (start_z + end_z) / 2.0)
	# Sign matters and is easy to get backwards: this rotation has to send
	# the far (+Z) end *down* to the street. Negated, the slab tilts the
	# other way and hangs over the plaza — and then it disagrees with
	# ground_height() below, so the player walks on a surface nowhere near
	# the visible ramp. That exact bug shipped in the WebGL build once.
	ramp.rotation.x = angle
	add_child(ramp)

	# Edge lighting so the ramp reads as walkable without a HUD marker.
	# Green because every affordance in this game is green.
	var lamp_mat := StandardMaterial3D.new()
	lamp_mat.albedo_color = Palette.ACCENT_GREEN
	lamp_mat.emission_enabled = true
	lamp_mat.emission = Palette.ACCENT_GREEN
	lamp_mat.emission_energy_multiplier = 2.5

	for i in range(11):
		var t := float(i) / 10.0
		var z := lerpf(start_z, end_z, t)
		var y := lerpf(DECK_Y, 0.0, t) + 0.25
		for x: float in [-2.6, 2.6]:
			var pip := MeshInstance3D.new()
			var pip_mesh := BoxMesh.new()
			pip_mesh.size = Vector3(0.12, 0.06, 0.5)
			pip_mesh.material = lamp_mat
			pip.mesh = pip_mesh
			pip.position = Vector3(x, y, z)
			add_child(pip)


## Highest walkable surface under (x, z): the deck, the ramp, or the street.
## Mirrors the WebXR build's Player.groundHeight so the two stay comparable.
func ground_height(x: float, z: float) -> float:
	var start_z := DECK_Z + DECK_D / 2.0
	var end_z := start_z + RAMP_LEN

	if absf(x) <= DECK_W / 2.0 and absf(z - DECK_Z) <= DECK_D / 2.0:
		return DECK_Y
	if absf(x) <= RAMP_HALF_W and z >= start_z and z <= end_z:
		return lerpf(DECK_Y, 0.0, (z - start_z) / RAMP_LEN)
	return 0.0


func _build_seating() -> void:
	# Benches face outward at the skyline. Somewhere to sit and look at the
	# thing the game is actually about.
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Palette.CUSHION
	mat.roughness = 0.92
	var albedo := load("res://assets/textures/fabric.jpg") as Texture2D
	var normal := load("res://assets/textures/fabric_n.jpg") as Texture2D
	if albedo:
		mat.albedo_texture = albedo
		mat.uv1_scale = Vector3(4, 4, 1)
	if normal:
		mat.normal_enabled = true
		mat.normal_texture = normal
		mat.normal_scale = 0.7

	var spots: Array[Vector3] = [
		Vector3(-7.0, DECK_Y + 0.45, DECK_Z - 6.0),
		Vector3(0.0, DECK_Y + 0.45, DECK_Z - 7.0),
		Vector3(7.0, DECK_Y + 0.45, DECK_Z - 6.0),
		Vector3(-9.0, DECK_Y + 0.45, DECK_Z + 2.0),
		Vector3(9.0, DECK_Y + 0.45, DECK_Z + 2.0),
		Vector3(0.0, DECK_Y + 0.45, DECK_Z + 5.0),
	]

	for p: Vector3 in spots:
		var seat := MeshInstance3D.new()
		var mesh := BoxMesh.new()
		mesh.size = Vector3(2.2, 0.5, 0.9)
		mesh.material = mat
		seat.mesh = mesh
		seat.position = p
		# Turn the outer benches to face the skyline rather than each other.
		seat.rotation.y = atan2(p.x, p.z - DECK_Z) * 0.35
		add_child(seat)
		seats.append(p)


func _build_lanterns() -> void:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Palette.ACCENT_GREEN
	mat.emission_enabled = true
	mat.emission = Palette.ACCENT_GREEN
	mat.emission_energy_multiplier = 3.0

	for i in 14:
		var lantern := MeshInstance3D.new()
		var mesh := SphereMesh.new()
		mesh.radius = 0.14
		mesh.height = 0.28
		mesh.radial_segments = 8
		mesh.rings = 4
		mesh.material = mat
		lantern.mesh = mesh
		lantern.position = Vector3(
			_rng.randf_range(-DECK_W / 2.0, DECK_W / 2.0),
			DECK_Y + _rng.randf_range(2.2, 3.6),
			DECK_Z + _rng.randf_range(-DECK_D / 2.0, DECK_D / 2.0))
		add_child(lantern)
		_lanterns.append(lantern)
		_lantern_phase.append(_rng.randf_range(0.0, TAU))


func _process(delta: float) -> void:
	# Lanterns drift. Slowly — this is the part of the game whose whole job
	# is to be calm, and anything with a readable rhythm stops being calm.
	var t := Time.get_ticks_msec() / 1000.0
	for i in _lanterns.size():
		var l: Node3D = _lanterns[i]
		if is_instance_valid(l):
			var phase: float = _lantern_phase[i]
			l.position.y += sin(t * 0.4 + phase) * delta * 0.12
			l.position.x += cos(t * 0.27 + phase) * delta * 0.08
