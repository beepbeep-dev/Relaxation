extends Node3D

## Boot, XR session setup, and the world's lighting.
##
## The XR half is the part that has no equivalent in the WebXR build: there,
## the browser owns the session and three.js just renders into it. Here the
## app owns it, which means initialising OpenXR explicitly and — critically —
## handing the frame timing over to the runtime rather than to the OS
## compositor. Getting that last step wrong is the classic Godot XR mistake:
## everything renders correctly, at half the headset's refresh rate, for no
## visible reason.

@onready var xr_origin: XROrigin3D = $XROrigin3D
@onready var camera: XRCamera3D = $XROrigin3D/XRCamera3D

var xr_interface: XRInterface


func _ready() -> void:
	_setup_xr()
	_setup_lighting()
	_setup_ground()


func _setup_xr() -> void:
	xr_interface = XRServer.find_interface("OpenXR")
	if xr_interface and xr_interface.is_initialized():
		# Hand frame pacing to the XR runtime: the compositor, not the OS,
		# decides when a frame is due. Leaving V-Sync on fights it and the
		# result is a stable-looking half-rate build.
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
		get_viewport().use_xr = true
		print("OpenXR initialised")
	else:
		# Not an error worth halting for: running flat on a desktop is how
		# this gets debugged without a headset attached.
		print("OpenXR unavailable — running flat")


func _setup_lighting() -> void:
	var sun := DirectionalLight3D.new()
	sun.light_color = Palette.KEY_LIGHT
	sun.light_energy = 2.2
	# Elevation matters more than it looks — see Palette.SUN_DIRECTION.
	sun.look_at_from_position(Vector3.ZERO, -Palette.SUN_DIRECTION, Vector3.UP)
	sun.shadow_enabled = true
	add_child(sun)

	var env := Environment.new()
	env.background_mode = Environment.BG_SKY
	var sky := Sky.new()
	var sky_mat := ProceduralSkyMaterial.new()
	sky_mat.sky_top_color = Palette.SKY_ZENITH
	sky_mat.sky_horizon_color = Palette.SKY_HORIZON
	sky_mat.ground_bottom_color = Palette.SKY_GROUND
	sky_mat.ground_horizon_color = Palette.SKY_HORIZON
	sky.sky_material = sky_mat
	env.sky = sky

	# Ambient comes from the sky itself, which is what keeps shadows purple
	# rather than neutral grey — the whole point of the colour script.
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_energy = 0.6

	env.fog_enabled = true
	env.fog_light_color = Palette.FOG
	env.fog_density = 0.005

	# Tone mapping, but deliberately no glow/bloom pass: a full-screen post
	# effect on a tile-based mobile GPU costs bandwidth this build does not
	# have. "Bloom" is emissive materials, same as in the WebXR build.
	env.tonemap_mode = Environment.TONE_MAPPER_ACES
	env.tonemap_exposure = 1.05

	var world_env := WorldEnvironment.new()
	world_env.environment = env
	add_child(world_env)


func _setup_ground() -> void:
	# Wet asphalt, not a mirror. Roughness is deliberately not near-zero: the
	# sky is dominated by a bright saturated horizon band, and a road much
	# smoother than this stops being a surface and becomes a mirror of the
	# sky's single strongest colour.
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Palette.WET_GROUND
	mat.roughness = 0.6
	mat.metallic = 0.22

	var plane := PlaneMesh.new()
	plane.size = Vector2(600, 600)
	plane.material = mat

	var ground := MeshInstance3D.new()
	ground.mesh = plane
	add_child(ground)
