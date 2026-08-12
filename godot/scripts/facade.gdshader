shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley, specular_schlick_ggx;

// Procedural building facades, evaluated in the fragment shader.
//
// Ported from src/world/facade.js, which is running and verified in the
// WebXR build.
//
// The point of computing rather than sampling: stretching one window texture
// across buildings from 9m to 60m wide gives every building a different
// storey height, and a skyline where storey height varies per building is the
// most obvious tell that a city is fake. Here a storey is 3.6m and a bay 2.6m
// on every building, because the UVs come from world-space metres rather than
// from the mesh.
//
// It also lets glass and concrete have genuinely different roughness and
// metallic response, which a single map cannot express — a map drives one
// channel.

uniform vec3 concrete_color : source_color = vec3(0.20, 0.23, 0.34);
uniform float floor_h = 3.6;
uniform float bay_w = 2.6;
uniform float emissive_mul : hint_range(0.0, 3.0) = 0.55;

varying vec3 facade_local;   // position in metres, centred on the box
varying vec3 facade_normal;  // object-space normal
varying float facade_y;      // world height, for floor alignment and grime
varying float facade_seed;   // per-instance variation
varying vec3 window_tint;

float facade_hash(vec2 p) {
	p = fract(p * vec2(233.34, 851.73));
	p += dot(p, p + 23.45);
	return fract(p.x * p.y);
}

void vertex() {
	// Recover the instance's world size from the model matrix columns. The
	// mesh is a unit box, so position * scale is the building's real extent
	// in metres. In Godot MODEL_MATRIX already includes the MultiMesh
	// instance transform, which is what carries the per-building scale.
	vec3 facade_scale = vec3(
		length(MODEL_MATRIX[0].xyz),
		length(MODEL_MATRIX[1].xyz),
		length(MODEL_MATRIX[2].xyz));

	facade_local = VERTEX * facade_scale;
	facade_normal = NORMAL;

	// A per-instance seed from the translation, so two towers of identical
	// size still light different windows.
	facade_seed = fract(dot(MODEL_MATRIX[3].xyz, vec3(0.0731, 0.1379, 0.0517)));

	facade_y = (MODEL_MATRIX * vec4(VERTEX, 1.0)).y;
	// MultiMesh per-instance colour arrives as COLOR, carrying each
	// building's window tint.
	window_tint = COLOR.rgb;
}

void fragment() {
	vec3 an = abs(facade_normal);
	bool is_wall = an.y < 0.5;

	// Horizontal axis runs along whichever face we are on; the vertical axis
	// is *world* Y, so floor lines run continuously across the separate boxes
	// that make up one tiered tower.
	float u = an.x > 0.5 ? facade_local.z : facade_local.x;

	vec2 cell = vec2(u / bay_w, facade_y / floor_h);
	vec2 id = floor(cell);
	vec2 g = fract(cell);

	float px = smoothstep(0.13, 0.17, g.x) * (1.0 - smoothstep(0.83, 0.87, g.x));
	float py = smoothstep(0.17, 0.21, g.y) * (1.0 - smoothstep(0.74, 0.78, g.y));
	float glass = px * py;

	float mullion = 1.0 - smoothstep(0.03, 0.07, abs(g.x - 0.5) - 0.42);
	float slab = 1.0 - smoothstep(0.02, 0.06, abs(g.y - 0.9) - 0.06);

	// Reveal: lit under the head of the window, shadowed above the sill.
	// Reads as a recessed pane without a normal map.
	float reveal = smoothstep(0.78, 0.72, g.y) * smoothstep(0.66, 0.74, g.y)
		- smoothstep(0.17, 0.23, g.y) * smoothstep(0.29, 0.23, g.y);

	float cell_rand = facade_hash(id + facade_seed * 37.1);
	float floor_rand = facade_hash(vec2(id.y, facade_seed * 71.3));
	float floor_lit = step(0.86, floor_rand);
	float lit = max(step(0.62, cell_rand), floor_lit * step(0.25, cell_rand));

	float pick = facade_hash(id.yx + facade_seed * 11.7);
	vec3 lit_color = pick < 0.4
		? vec3(0.78, 0.96, 0.90)
		: (pick < 0.75 ? vec3(0.62, 0.83, 1.00) : vec3(0.76, 0.71, 1.00));
	lit_color *= 1.0 + step(0.93, facade_hash(id + facade_seed * 5.3)) * 0.7;

	// Ground-floor shopfronts, confined to roughly one storey. Spilling this
	// over two storeys made every building wear a solid white band at eye
	// level.
	float podium = (1.0 - smoothstep(floor_h * 0.8, floor_h * 1.4, facade_y))
		* (0.45 + 0.55 * step(0.35, cell_rand));

	vec3 albedo_out = concrete_color;
	float rough = 0.85;
	float metal = 0.05;
	vec3 emission_out = vec3(0.0);

	if (is_wall) {
		vec3 spandrel = albedo_out * 0.82;
		vec3 structure = albedo_out * 1.22;
		vec3 glass_tint = vec3(0.035, 0.055, 0.10);

		albedo_out = mix(mix(spandrel, structure, max(mullion, slab)), glass_tint, glass);
		albedo_out *= 1.0 + reveal * 0.55;
		// Street grime rising off the pavement.
		albedo_out *= mix(0.55, 1.0, smoothstep(0.0, 14.0, facade_y));

		// The split a texture cannot express: glass is smooth and metallic
		// and mirrors the environment, concrete stays rough.
		rough = mix(rough, 0.08, glass);
		metal = mix(metal, 0.9, glass);

		float on = max(lit, podium * 0.8);
		emission_out = lit_color * glass * on * window_tint * emissive_mul;
		emission_out += lit_color * slab * on * 0.05;
	} else {
		albedo_out *= 0.7;   // roof decks
	}

	ALBEDO = albedo_out;
	ROUGHNESS = rough;
	METALLIC = metal;
	EMISSION = emission_out;
}
