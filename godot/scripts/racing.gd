extends Node3D

## NEON MILE — a street circuit through the city, ported from
## src/games/racing.js.
##
## The track runs down the streets, not on a floating skyway. An earlier
## version drew a ribbon on its own radius and drove straight through tower
## blocks, because the track and the city were generated independently and
## nothing reconciled them. Routing the circuit along street centrelines
## fixes that by construction: the streets are the one part of the map
## guaranteed to be clear, because that is where the buildings are not. It is
## also the honest answer to "make it realistic" — real city races are run on
## closed public roads, between the buildings.
##
## Speeds are the other half of "realistic". The first pass topped out around
## 220 km/h down an eight-metre street, which is not exhilarating, it is a
## blur you cannot read. These numbers are a fast road car, and the brakes
## are deliberately far stronger than the engine, which is true of real cars
## and is what makes a corner a decision rather than a formality.

const BLOCK := 42.0
const STREET := 14.0
const LAPS := 3
const TRACK_HALF_WIDTH := STREET / 2.0 - 1.2   ## fits between the kerbs

const IDLE_SPEED := 8.0      ## m/s off-throttle, ~29 km/h
const CRUISE_SPEED := 26.0   ## m/s part-throttle, ~94 km/h
const MAX_SPEED := 38.0      ## m/s flat out, ~137 km/h
const BRAKE_RATE := 26.0     ## m/s^2 — brakes are far stronger than the engine
const ACCEL_RATE := 7.5      ## m/s^2 — and acceleration is not instant
const BOOST_GAIN := 4.0      ## boost tops out around 150 km/h, not 220
const OPPONENTS := 5

const CORNER_R := 26.0
const TRACK_Y := 0.28        ## just proud of the road surface

class Rival:
	var t := 0.0
	var speed := 0.0
	var offset := 0.0
	var line := 0.0
	var pace := 1.0
	var lap := -1
	var body: Node3D = null

var racing := false
var lap := 0
var speed := IDLE_SPEED
var progress := 0.0          ## 0..1 around the circuit
var rivals: Array[Rival] = []

var _points: PackedVector3Array = PackedVector3Array()
var _cumulative: PackedFloat32Array = PackedFloat32Array()
var _total_length := 0.0
var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	_rng.seed = 7311
	_build_track()
	_build_ribbon()


## A rounded rectangle laid on the street grid.
func _build_track() -> void:
	var s := BLOCK * 2.5      # half-extent, landing on a street centreline
	var i := s - CORNER_R
	var pts: Array[Vector3] = []

	var straight := func(x0: float, z0: float, x1: float, z1: float, n: int) -> void:
		for k in n:
			var f := float(k) / float(n)
			pts.append(Vector3(lerpf(x0, x1, f), TRACK_Y, lerpf(z0, z1, f)))

	var corner := func(cx: float, cz: float, a0: float, a1: float, n: int) -> void:
		for k in range(n + 1):
			var a := lerpf(a0, a1, float(k) / float(n))
			pts.append(Vector3(cx + cos(a) * CORNER_R, TRACK_Y, cz + sin(a) * CORNER_R))

	straight.call(s, -i, s, i, 8)
	corner.call(i, i, 0.0, PI / 2.0, 6)
	straight.call(i, s, -i, s, 8)
	corner.call(-i, i, PI / 2.0, PI, 6)
	straight.call(-s, i, -s, -i, 8)
	corner.call(-i, -i, PI, PI * 1.5, 6)
	straight.call(-i, -s, i, -s, 8)
	corner.call(i, -i, PI * 1.5, TAU, 6)

	_points = PackedVector3Array(pts)

	# Arc-length table. Without one, a constant step in the parameter is not a
	# constant step in metres, so a car "accelerates" through every corner
	# purely because the samples bunch up there.
	_cumulative.resize(_points.size() + 1)
	_cumulative[0] = 0.0
	var total := 0.0
	for k in _points.size():
		total += _points[k].distance_to(_points[(k + 1) % _points.size()])
		_cumulative[k + 1] = total
	_total_length = total


## Position on the circuit at t in 0..1, measured in arc length rather than
## in samples, so speed in metres per second means what it says.
func point_at(t: float) -> Vector3:
	var target := fposmod(t, 1.0) * _total_length
	var lo := 0
	var hi := _cumulative.size() - 1
	while lo + 1 < hi:
		var mid := (lo + hi) / 2
		if _cumulative[mid] <= target:
			lo = mid
		else:
			hi = mid
	var seg_len := _cumulative[lo + 1] - _cumulative[lo]
	var f := 0.0 if seg_len <= 0.0 else (target - _cumulative[lo]) / seg_len
	return _points[lo].lerp(_points[(lo + 1) % _points.size()], f)


func tangent_at(t: float) -> Vector3:
	var a := point_at(t)
	var b := point_at(t + 0.002)
	var d := b - a
	return d.normalized() if d.length_squared() > 1e-8 else Vector3.FORWARD


func _build_ribbon() -> void:
	# The racing surface: a flat strip following the circuit, lit along both
	# kerbs. Green marks the racing line the way every affordance in this
	# game is green — it is the rarest colour in the palette, so it is what
	# the eye follows.
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)

	var steps := 240
	for k in range(steps + 1):
		var t := float(k) / float(steps)
		var p := point_at(t)
		var tan := tangent_at(t)
		var right := tan.cross(Vector3.UP).normalized()
		st.set_uv(Vector2(0.0, t * 40.0))
		st.add_vertex(p - right * TRACK_HALF_WIDTH)
		st.set_uv(Vector2(1.0, t * 40.0))
		st.add_vertex(p + right * TRACK_HALF_WIDTH)

	var idx := PackedInt32Array()
	for k in steps:
		var a := k * 2
		idx.append_array([a, a + 1, a + 2, a + 1, a + 3, a + 2])
	for n in idx:
		st.add_index(n)
	st.generate_normals()

	var mat := StandardMaterial3D.new()
	mat.albedo_color = Palette.DARK_METAL
	mat.roughness = 0.45
	mat.metallic = 0.3
	mat.emission_enabled = true
	mat.emission = Palette.ACCENT_BLUE
	mat.emission_energy_multiplier = 0.15
	# Handed to SurfaceTool before commit, rather than set afterwards via
	# `mesh.mesh.surface_set_material`: MeshInstance3D.mesh is the base Mesh
	# type, which has no surface_set_material, so that route is a parse error.
	st.set_material(mat)

	var mesh := MeshInstance3D.new()
	mesh.mesh = st.commit()
	add_child(mesh)


func begin() -> void:
	racing = true
	lap = 0
	speed = IDLE_SPEED
	progress = 0.0
	_reset_rivals()


func _reset_rivals() -> void:
	for r: Rival in rivals:
		if is_instance_valid(r.body):
			r.body.queue_free()
	rivals.clear()

	for i in OPPONENTS:
		var r := Rival.new()
		# The grid sits *behind* the start line, so lap starts at -1: a car
		# that begins at t=0.99 with lap=0 would cross the line immediately
		# and be scored a lap ahead of everyone before the race began.
		r.t = 1.0 - float(i + 1) * 0.012
		r.lap = -1
		r.speed = IDLE_SPEED
		r.line = _rng.randf_range(-0.7, 0.7)
		r.offset = r.line * (TRACK_HALF_WIDTH - 2.0)
		# Slightly different pace each, so the field spreads instead of
		# travelling as one block.
		r.pace = _rng.randf_range(0.82, 0.97)
		r.body = _build_car(Palette.NEON[i % Palette.NEON.size()])
		add_child(r.body)
		rivals.append(r)


func _build_car(tint: Color) -> Node3D:
	var root := Node3D.new()

	var mat := StandardMaterial3D.new()
	mat.albedo_color = Palette.DARK_METAL
	mat.roughness = 0.25
	mat.metallic = 0.8

	var body := MeshInstance3D.new()
	var body_mesh := BoxMesh.new()
	body_mesh.size = Vector3(1.8, 0.5, 4.0)
	body_mesh.material = mat
	body.mesh = body_mesh
	body.position = Vector3(0, 0.45, 0)
	root.add_child(body)

	# Tail lights carry the tint: at racing distance the light is the only
	# part of another car you actually read.
	var glow := StandardMaterial3D.new()
	glow.albedo_color = tint
	glow.emission_enabled = true
	glow.emission = tint
	glow.emission_energy_multiplier = 3.0

	var tail := MeshInstance3D.new()
	var tail_mesh := BoxMesh.new()
	tail_mesh.size = Vector3(1.6, 0.16, 0.1)
	tail_mesh.material = glow
	tail.mesh = tail_mesh
	tail.position = Vector3(0, 0.55, 2.0)
	root.add_child(tail)

	return root


func _process(delta: float) -> void:
	if not racing:
		return
	_update_rivals(delta)


func _update_rivals(delta: float) -> void:
	for r: Rival in rivals:
		# Slow for corners: sample the curve a little ahead and compare
		# headings. A car that takes corners at full speed reads as being on
		# rails, which is the opposite of the point.
		var here := tangent_at(r.t)
		var ahead := tangent_at(r.t + 0.02)
		var bend: float = clampf(here.dot(ahead), 0.0, 1.0)
		var corner_factor := lerpf(0.55, 1.0, bend)

		var target := MAX_SPEED * r.pace * corner_factor
		r.speed += clampf(target - r.speed, -BRAKE_RATE * delta, ACCEL_RATE * delta)
		r.t = fposmod(r.t + (r.speed * delta) / _total_length, 1.0)
		r.offset += (r.line * (TRACK_HALF_WIDTH - 2.0) - r.offset) * minf(1.0, delta * 0.8)

		if is_instance_valid(r.body):
			var p := point_at(r.t)
			var tan := tangent_at(r.t)
			var right := tan.cross(Vector3.UP).normalized()
			r.body.position = p + right * r.offset
			r.body.rotation.y = atan2(tan.x, tan.z)
