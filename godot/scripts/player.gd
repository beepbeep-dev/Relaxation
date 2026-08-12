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

var _snap_cooldown := 0.0
var _turn_latched := false


func _process(delta: float) -> void:
	_snap_cooldown = maxf(0.0, _snap_cooldown - delta)
	_handle_snap_turn()
	_handle_movement(delta)


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
