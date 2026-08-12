extends SceneTree

## Headless smoke test for the Godot build.
##
## Run with:
##   godot --headless --script res://scripts/smoke.gd
##
## Why this exists: every GDScript error so far has cost a full CI round trip
## — several minutes to discover a one-line parse error. Godot parses every
## script it loads, so simply *constructing* the scene catches the entire
## class of failure that has actually been biting (parse errors, unknown
## methods on typed variables, bad property names) in seconds rather than
## minutes.
##
## It cannot check rendering or headset behaviour, and does not pretend to.
## What it asserts is that the world builds, the geometry lands where the
## design says it should, and the game logic advances when stepped.

var _failures := 0


func _ok(label: String) -> void:
	print("ok    ", label)


func _fail(label: String) -> void:
	push_error("FAIL  " + label)
	print("FAIL  ", label)
	_failures += 1


func _check(condition: bool, label: String) -> void:
	if condition:
		_ok(label)
	else:
		_fail(label)


func _initialize() -> void:
	print("\n--- Kaisei smoke test ---\n")

	var main: Node = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	_check(main != null, "main scene instantiates")

	_check_city(main)
	_check_lounge(main)
	_check_racing(main)
	_check_sword(main)

	print("")
	if _failures == 0:
		print("SMOKE PASSED")
		quit(0)
	else:
		print("SMOKE FAILED (%d)" % _failures)
		quit(1)


func _check_city(main: Node) -> void:
	var city: Node = main.get_node_or_null("City")
	if city == null:
		_fail("city node present")
		return
	# Every tower is one MultiMesh instance, so a low child count is the
	# point rather than a shortfall: draw calls are the budget on a
	# tile-based mobile GPU.
	var multimeshes := 0
	var instances := 0
	for c in city.get_children():
		if c is MultiMeshInstance3D:
			multimeshes += 1
			instances += (c as MultiMeshInstance3D).multimesh.instance_count
	_check(multimeshes > 0, "city built %d MultiMesh draw calls" % multimeshes)
	_check(instances > 100, "city placed %d instanced boxes" % instances)
	_check(city.colliders.size() > 0, "city produced %d colliders" % city.colliders.size())


func _check_lounge(main: Node) -> void:
	var lounge: Node = main.get_node_or_null("Lounge")
	if lounge == null:
		_fail("lounge node present")
		return
	_check(lounge.seats.size() >= 4, "lounge has %d seats" % lounge.seats.size())

	# The deck must be at deck height and the street at zero — this is the
	# assertion that would have caught the WebGL build's inverted ramp, where
	# the walkable surface disagreed with the visible slab.
	var on_deck: float = lounge.ground_height(0.0, lounge.DECK_Z)
	var on_street: float = lounge.ground_height(0.0, 60.0)
	_check(is_equal_approx(on_deck, lounge.DECK_Y), "deck is walkable at %.1fm" % on_deck)
	_check(is_equal_approx(on_street, 0.0), "street is at ground level")

	# Halfway up the ramp should be halfway up, and strictly between the two.
	var start_z: float = lounge.DECK_Z + lounge.DECK_D / 2.0
	var mid: float = lounge.ground_height(0.0, start_z + lounge.RAMP_LEN / 2.0)
	_check(mid > 0.5 and mid < lounge.DECK_Y - 0.5,
		"ramp mid-point at %.2fm, between street and deck" % mid)


func _check_racing(main: Node) -> void:
	var circuit: Node = main.get_node_or_null("Circuit")
	if circuit == null:
		_fail("circuit node present")
		return

	circuit.begin()
	_check(circuit.rivals.size() == circuit.OPPONENTS,
		"%d rivals on the grid" % circuit.rivals.size())

	# Every rival starts behind the line. A rival at t=0.99 with lap=0 would
	# cross immediately and be scored a lap up before the race began.
	var all_behind := true
	for r in circuit.rivals:
		if r.lap != -1:
			all_behind = false
	_check(all_behind, "rivals start behind the line (lap -1)")

	# Step the race and confirm the field actually moves, at plausible speed.
	var before: Array[float] = []
	for r in circuit.rivals:
		before.append(r.t)
	for i in 240:
		circuit._update_rivals(1.0 / 60.0)
	var moved := 0
	var top := 0.0
	for i in circuit.rivals.size():
		if circuit.rivals[i].t != before[i]:
			moved += 1
		top = maxf(top, circuit.rivals[i].speed)
	_check(moved == circuit.rivals.size(), "all %d rivals advanced" % moved)
	_check(top <= circuit.MAX_SPEED + 0.5,
		"top speed %.0f km/h stays a car, not a missile" % (top * 3.6))


func _check_sword(main: Node) -> void:
	var dojo: Node = main.get_node_or_null("Dojo")
	if dojo == null:
		_fail("dojo node present")
		return

	dojo.begin()
	_check(dojo.health == dojo.START_HEALTH, "fight starts at full health")

	# Spawn a wave and walk it forward. Opponents must close on the player,
	# which is the bug that reached a real player once: they converged on the
	# arena origin instead and stopped short.
	for i in 8:
		dojo._maybe_spawn(1.0)
	_check(dojo.enemies.size() > 0, "%d opponents spawned" % dojo.enemies.size())

	var start_distance := _closest(dojo)
	for i in 600:
		dojo._process(1.0 / 60.0)
	var end_distance := _closest(dojo)
	_check(end_distance < start_distance,
		"opponents closed from %.1fm to %.1fm" % [start_distance, end_distance])
	_check(end_distance <= dojo.STRIKE_RANGE + 0.3,
		"opponents reached striking distance (%.2fm)" % end_distance)

	# Left alone, the player dies. It does not stop.
	_check(dojo.health < dojo.START_HEALTH, "an idle player takes hits")


func _closest(dojo: Node) -> float:
	var head: Vector3 = dojo.to_local(Vector3.ZERO)
	var best := INF
	for e in dojo.enemies:
		best = minf(best, Vector2(head.x - e.pos.x, head.z - e.pos.z).length())
	return best
