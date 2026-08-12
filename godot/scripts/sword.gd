extends Node3D

## STEEL GARDEN — sword fighting, endless, until you die.
##
## Ported from src/games/sword.js. Humanoid opponents walk at you with
## swords, you cut them by actually swinging, they cut you back, and it does
## not stop until you are dead.
##
## Two rules keep it from being a windmill:
##  - A cut needs real blade speed (KILL_SPEED). Resting your sword inside
##    someone does nothing, so you have to swing properly.
##  - A block is positional: when their blade comes down, yours has to be
##    near it. Not an angle puzzle — just put your sword in the way, which is
##    what everyone tries to do instinctively anyway.
##
## Opponents steer at the player's actual head position every frame. An
## earlier version of the JS file shrank a radius about the arena's origin
## instead, so a player standing off-centre watched opponents converge on
## empty space and stop — a real bug that reached a real player. It is worth
## being explicit about here so it does not get reintroduced by someone
## "simplifying" the approach step back into a radius.

const ARENA_R := 7.0
const FRONT_ARC := PI * 0.7    ## enemies only come from in front — seated-viable
const MAX_ENEMIES := 8

const STRIKE_RANGE := 1.9
const WINDUP := 0.85           ## seconds with the sword raised before it falls
const RECOVER := 0.7
const BLOCK_RADIUS := 0.45
const KILL_SPEED := 2.6        ## m/s of blade tip needed to cut, not nudge
const START_HEALTH := 5

enum State { APPROACH, WINDUP, STRIKE, RECOVER, FALLING }

class Enemy:
	var pos := Vector3.ZERO
	var speed := 1.0
	var state: int = State.APPROACH
	var timer := 0.0
	var gait := 0.0
	var swing := 0.0
	var fall := 0.0
	var hp := 1
	var knockback := 0.0
	var yaw := 0.0
	var body: Node3D = null

var enemies: Array[Enemy] = []
var wave := 1
var kills := 0
var score := 0
var health := START_HEALTH
var fighting := false

var _rng := RandomNumberGenerator.new()
var _spawn_timer := 0.0

## The player's blade, as a segment in this node's local space. Whatever
## drives the controller writes these each frame; combat only ever reads
## them, so the fight logic never has to know how the sword is held.
var blade_a := Vector3.ZERO
var blade_b := Vector3.ZERO
var blade_tip_speed := 0.0


func _ready() -> void:
	_rng.seed = 5150


func begin() -> void:
	for e: Enemy in enemies:
		if is_instance_valid(e.body):
			e.body.queue_free()
	enemies.clear()
	wave = 1
	kills = 0
	score = 0
	health = START_HEALTH
	_spawn_timer = 0.5
	fighting = true


func _process(delta: float) -> void:
	if not fighting:
		return
	_maybe_spawn(delta)
	_update_enemies(delta)


func _maybe_spawn(delta: float) -> void:
	# The pressure never stops, it only grows.
	var target: int = mini(2 + wave / 2, MAX_ENEMIES)
	_spawn_timer -= delta
	if _spawn_timer <= 0.0 and enemies.size() < target:
		_spawn_enemy()
		_spawn_timer = maxf(0.7, 2.4 - wave * 0.14)


func _spawn_enemy() -> void:
	if enemies.size() >= MAX_ENEMIES:
		return
	var angle := _rng.randf_range(-FRONT_ARC, FRONT_ARC)
	var spawn_r := ARENA_R - 0.5

	var e := Enemy.new()
	e.pos = Vector3(sin(angle) * spawn_r, 0.0, -cos(angle) * spawn_r)
	e.speed = 0.9 + wave * 0.08 + _rng.randf_range(-0.15, 0.25)
	e.gait = _rng.randf_range(0.0, TAU)
	e.hp = 2 if wave > 4 else 1
	e.body = _build_body()
	add_child(e.body)
	enemies.append(e)


## A blocky humanoid: torso, head, and a sword. Deliberately simple — the
## read that matters at combat distance is the silhouette and the raised
## sword, not the detail.
func _build_body() -> Node3D:
	var root := Node3D.new()

	var mat := StandardMaterial3D.new()
	mat.albedo_color = Palette.DARK_METAL
	mat.roughness = 0.6

	var torso := MeshInstance3D.new()
	var torso_mesh := BoxMesh.new()
	torso_mesh.size = Vector3(0.44, 0.7, 0.26)
	torso_mesh.material = mat
	torso.mesh = torso_mesh
	torso.position = Vector3(0, 1.05, 0)
	root.add_child(torso)

	var head := MeshInstance3D.new()
	var head_mesh := BoxMesh.new()
	head_mesh.size = Vector3(0.22, 0.24, 0.22)
	head_mesh.material = mat
	head.mesh = head_mesh
	head.position = Vector3(0, 1.48, 0)
	root.add_child(head)

	# The blade glows: it is the tell that a blow is coming, so it has to
	# read at a glance in a dark city.
	var blade_mat := StandardMaterial3D.new()
	blade_mat.albedo_color = Palette.ACCENT_PURPLE
	blade_mat.emission_enabled = true
	blade_mat.emission = Palette.ACCENT_PURPLE
	blade_mat.emission_energy_multiplier = 2.0

	var sword := MeshInstance3D.new()
	var sword_mesh := BoxMesh.new()
	sword_mesh.size = Vector3(0.05, 0.95, 0.05)
	sword_mesh.material = blade_mat
	sword.mesh = sword_mesh
	sword.name = "Sword"
	sword.position = Vector3(0.3, 1.4, 0)
	root.add_child(sword)

	return root


func _update_enemies(delta: float) -> void:
	var head_local: Vector3 = to_local(_player_head_global())

	# `e` is annotated because Array.duplicate() hands back an untyped array,
	# so without this the loop variable is a Variant and every `:=` below
	# fails to infer ("Cannot infer the type of 'dx'"). The copy itself is
	# deliberate: the body removes enemies, and mutating the array being
	# iterated skips elements.
	for e: Enemy in enemies.duplicate():
		if e.state == State.FALLING:
			e.fall += delta * 2.2
			if e.fall >= 1.0:
				_remove_enemy(e)
			else:
				_pose(e)
			continue

		var dx: float = head_local.x - e.pos.x
		var dz: float = head_local.z - e.pos.z
		var distance := sqrt(dx * dx + dz * dz)
		if distance <= 0.0:
			distance = 1e-4
		e.yaw = atan2(dx, dz)

		match e.state:
			State.APPROACH:
				if distance > STRIKE_RANGE:
					var step: float = minf(e.speed * delta, distance - STRIKE_RANGE)
					e.pos.x += (dx / distance) * step
					e.pos.z += (dz / distance) * step
					e.gait += delta * e.speed * 5.5
				else:
					e.state = State.WINDUP
					e.timer = 0.0
					e.swing = 0.0
			State.WINDUP:
				e.timer += delta
				e.swing = 0.0
				if e.timer >= WINDUP:
					e.state = State.STRIKE
					e.timer = 0.0
			State.STRIKE:
				e.timer += delta
				e.swing = minf(1.0, e.timer / 0.16)
				if e.swing >= 1.0:
					_resolve_enemy_strike(e, head_local, distance)
					e.state = State.RECOVER
					e.timer = 0.0
			State.RECOVER:
				e.timer += delta
				e.swing = maxf(0.0, 1.0 - e.timer / RECOVER)
				if e.timer >= RECOVER:
					e.state = State.APPROACH
					_step_back(e, head_local, 0.7)

		# Your cut. Needs speed — resting the blade on someone does nothing.
		var chest := Vector3(e.pos.x, 1.05, e.pos.z)
		if _distance_to_blade(chest) < 0.55 and blade_tip_speed > KILL_SPEED:
			_cut(e)
		if e.knockback != 0.0:
			_step_back(e, head_local, e.knockback)
			e.knockback = 0.0

		_pose(e)


func _player_head_global() -> Vector3:
	var cam := get_viewport().get_camera_3d()
	return cam.global_position if cam else Vector3.ZERO


## Push an opponent directly away from the player, staying inside the arena.
func _step_back(e: Enemy, head_local: Vector3, amount: float) -> void:
	var dx := e.pos.x - head_local.x
	var dz := e.pos.z - head_local.z
	var d := sqrt(dx * dx + dz * dz)
	if d <= 0.0:
		d = 1e-4
	e.pos.x += (dx / d) * amount
	e.pos.z += (dz / d) * amount
	var r := sqrt(e.pos.x * e.pos.x + e.pos.z * e.pos.z)
	if r > ARENA_R - 0.5:
		var k := (ARENA_R - 0.5) / r
		e.pos.x *= k
		e.pos.z *= k


## Distance from a point to the player's blade, treated as a segment.
func _distance_to_blade(point: Vector3) -> float:
	var ab := blade_b - blade_a
	var len2 := ab.length_squared()
	if len2 <= 0.0:
		return point.distance_to(blade_a)
	var t: float = clampf((point - blade_a).dot(ab) / len2, 0.0, 1.0)
	return point.distance_to(blade_a + ab * t)


## Their blade comes down. You block by having your sword near theirs.
func _resolve_enemy_strike(e: Enemy, head_local: Vector3, distance: float) -> void:
	var dx := head_local.x - e.pos.x
	var dz := head_local.z - e.pos.z
	var d := sqrt(dx * dx + dz * dz)
	if d <= 0.0:
		d = 1.0
	# Where their sword ends the swing: in front of them, at chest height,
	# on the line towards you.
	var impact := Vector3(e.pos.x + (dx / d) * 0.9, 1.15, e.pos.z + (dz / d) * 0.9)

	if _distance_to_blade(impact) < BLOCK_RADIUS:
		score += 15
	elif distance < STRIKE_RANGE + 0.6:
		health -= 1
		if health <= 0:
			fighting = false


func _cut(e: Enemy) -> void:
	e.hp -= 1
	if e.hp > 0:
		# Staggered: knocked out of whatever they were doing, pushed back.
		e.state = State.RECOVER
		e.timer = 0.0
		e.knockback = 0.9
		score += 25
		return
	e.state = State.FALLING
	e.fall = 0.0
	kills += 1
	score += 100
	wave = 1 + kills / 5


func _remove_enemy(e: Enemy) -> void:
	if is_instance_valid(e.body):
		e.body.queue_free()
	enemies.erase(e)


func _pose(e: Enemy) -> void:
	if not is_instance_valid(e.body):
		return
	var fallen := e.fall if e.state == State.FALLING else 0.0
	e.body.position = Vector3(e.pos.x, e.pos.y + fallen * 0.1, e.pos.z)
	e.body.rotation = Vector3(fallen * -1.35, e.yaw, 0.0)

	# Sword arm: raised through the windup, chops down through the strike.
	var sword := e.body.get_node_or_null("Sword")
	if sword:
		sword.rotation = Vector3(lerpf(-2.1, 0.65, e.swing), 0.0, -0.2)
