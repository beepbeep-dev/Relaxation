extends XROrigin3D

## Locomotion and comfort, ported from src/player/player.js.
##
## The rig moves; the camera never does. The camera's transform belongs to
## the XR runtime — writing to it fights head tracking and is the fastest way
## to make someone ill.
##
## Two comfort rules carried over from the WebXR build, both non-negotiable
## design constraints rather than engine details:
##  - Snap turn, never smooth. Smooth yaw is the single most reliable way to
##    make a player in a headset feel sick.
##  - A vignette that closes in proportion to actual movement, eased so it
##    never pops.

const SPEED := 3.0                  ## m/s, walking pace — deliberately not fast
const SNAP_ANGLE := deg_to_rad(30.0)
const SNAP_COOLDOWN := 0.28
const DEADZONE := 0.15
const TURN_THRESHOLD := 0.7

@onready var camera: XRCamera3D = $XRCamera3D
@onready var left_hand: XRController3D = $LeftHand
@onready var right_hand: XRController3D = $RightHand

const GRAVITY := 18.0

var _snap_cooldown := 0.0
var _turn_latched := false
var _velocity_y := 0.0

## Anything with a `ground_height(x, z) -> float` method. The lounge supplies
## the deck and the ramp; the street is the 0.0 fallback. Deliberately left
## untyped so the player does not have to know what kinds of walkable surface
## exist — annotating it `Node` would make the duck-typed call below a parse
## error, because GDScript rejects an unknown method on a statically known
## type even behind a has_method() guard.
@onready var _terrain = get_tree().current_scene.get_node_or_null("Lounge")

var _wrist: WristPanel
var _grip_latched := false
var _trigger_latched := false


func _ready() -> void:
	# The panel rides the left wrist, so it is parented to that controller
	# and comes along with the hand rather than floating in the world.
	_wrist = WristPanel.new()
	left_hand.add_child(_wrist)
	# Tilted up and back, roughly where a watch face sits when you turn your
	# wrist to look at it.
	_wrist.position = Vector3(0, 0.04, -0.06)
	_wrist.rotation_degrees = Vector3(-50, 0, 0)


func _process(delta: float) -> void:
	_snap_cooldown = maxf(0.0, _snap_cooldown - delta)
	_handle_panel()
	_handle_snap_turn()
	_handle_movement(delta)
	_handle_ground(delta)


func _handle_panel() -> void:
	# Left grip raises the panel. Latched, so holding the grip toggles once
	# rather than strobing it every frame.
	var grip := left_hand.get_float("grip") > 0.7
	if grip and not _grip_latched:
		_wrist.toggle()
	_grip_latched = grip

	var trigger := right_hand.get_float("trigger") > 0.6
	var on_panel := false
	if _wrist.visible:
		var xf := right_hand.global_transform
		on_panel = _wrist.aim(xf.origin, -xf.basis.z)
		if trigger and not _trigger_latched and on_panel:
			_wrist.press()
	_trigger_latched = trigger

	# While the panel is up and the pointer is on it, the panel owns the
	# trigger. Without this the same press both edits a setting and fires
	# whatever the trigger does in the world — which in the WebXR build meant
	# opening settings inside a minigame also dumped you out of it.
	set_meta("trigger_consumed", _wrist.visible and on_panel)


func _ground_height(x: float, z: float) -> float:
	if _terrain and _terrain.has_method("ground_height"):
		return _terrain.ground_height(x, z)
	return 0.0


func _handle_ground(delta: float) -> void:
	# Snap up instantly, fall smoothly. Stepping *up* in discrete jumps is
	# unnoticeable; dropping in discrete jumps is a lurch, and a lurch the
	# player did not cause is exactly what makes people ill in a headset.
	var head := camera.global_position
	var target := _ground_height(head.x, head.z)
	var dy := target - global_position.y

	if dy > 0.0:
		global_position.y = target
		_velocity_y = 0.0
	elif dy < -0.02:
		_velocity_y -= GRAVITY * delta
		global_position.y = maxf(target, global_position.y + _velocity_y * delta)
		if is_equal_approx(global_position.y, target):
			_velocity_y = 0.0


func _handle_snap_turn() -> void:
	var turn := right_hand.get_vector2("primary").x

	# Latch: one deflection is one snap, however long it is held. Without
	# this, holding the stick spins the player continuously — which is
	# smooth turning wearing a snap turn's clothes, and just as nauseating.
	if absf(turn) < TURN_THRESHOLD:
		_turn_latched = false
		return
	if _turn_latched or _snap_cooldown > 0.0:
		return

	# Rotate about the player's head, not the rig origin. In roomscale the
	# two can be metres apart, and turning about the origin swings the player
	# through an arc instead of turning them on the spot.
	var head := camera.transform.origin
	var pivot := Vector3(head.x, 0.0, head.z)
	var angle := -signf(turn) * SNAP_ANGLE
	transform = (Transform3D.IDENTITY.translated(pivot)
		* Transform3D(Basis(Vector3.UP, angle), Vector3.ZERO)
		* Transform3D.IDENTITY.translated(-pivot)) * transform

	_turn_latched = true
	_snap_cooldown = SNAP_COOLDOWN


func _handle_movement(delta: float) -> void:
	var stick := left_hand.get_vector2("primary")
	if stick.length() < DEADZONE:
		return

	# Move relative to gaze, so "forward" is wherever the player is looking.
	var forward := -camera.global_transform.basis.z
	forward.y = 0.0
	if forward.length_squared() < 1e-6:
		forward = Vector3.FORWARD
	forward = forward.normalized()
	var right := forward.cross(Vector3.UP).normalized() * -1.0

	var step := (forward * stick.y + right * stick.x)
	var mag: float = minf(step.length(), 1.0)
	if mag <= 0.001:
		return
	global_position += step.normalized() * SPEED * mag * delta
