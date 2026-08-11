Shader "Kaisei/Facade"
{
    // Procedural building facades, evaluated in the fragment shader.
    //
    // Ported from src/world/facade.js, which is running and verified in the
    // WebXR build. NOT yet compiled by Unity — see unity/README.md.
    //
    // The point of computing rather than sampling: stretching one window
    // texture across buildings from 9m to 60m wide gives every building a
    // different storey height, and a skyline where storey height varies per
    // building is the most obvious tell that a city is fake. Here a storey is
    // 3.6m and a bay 2.6m on every building, because the UVs come from
    // world-space metres rather than from the mesh.
    //
    // It also lets glass and concrete have genuinely different roughness and
    // metallic response, which a single map cannot express — a map drives one
    // channel.

    Properties
    {
        _Concrete   ("Concrete", Color) = (0.20, 0.23, 0.34, 1)
        _FloorH     ("Storey height (m)", Float) = 3.6
        _BayW       ("Window bay (m)", Float) = 2.6
        _EmissiveMul("Window brightness", Range(0, 3)) = 0.55
    }

    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }
        LOD 200

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0

            // Instancing is not optional here: the whole city is one mesh
            // drawn many times, and the per-instance colour carries each
            // building's window tint.
            #pragma multi_compile_instancing
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _ADDITIONAL_LIGHTS
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS  : SV_POSITION;
                float3 positionWS  : TEXCOORD0;
                float3 normalWS    : TEXCOORD1;
                float3 facadeLocal : TEXCOORD2;   // position in metres, centred on the box
                float3 normalOS    : TEXCOORD3;
                float  seed        : TEXCOORD4;
                float  fogCoord    : TEXCOORD5;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            CBUFFER_START(UnityPerMaterial)
                float4 _Concrete;
                float  _FloorH;
                float  _BayW;
                float  _EmissiveMul;
            CBUFFER_END

            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float4, _WindowTint)
            UNITY_INSTANCING_BUFFER_END(Props)

            float FacadeHash(float2 p)
            {
                p = frac(p * float2(233.34, 851.73));
                p += dot(p, p + 23.45);
                return frac(p.x * p.y);
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_TRANSFER_INSTANCE_ID(IN, OUT);

                // Recover the instance's world size from the object-to-world
                // matrix columns. The mesh is a unit cube, so position * scale
                // is the building's real extent in metres.
                float3 scale = float3(
                    length(unity_ObjectToWorld._m00_m10_m20),
                    length(unity_ObjectToWorld._m01_m11_m21),
                    length(unity_ObjectToWorld._m02_m12_m22));

                OUT.facadeLocal = IN.positionOS.xyz * scale;
                OUT.normalOS    = IN.normalOS;

                // A per-instance seed from the translation, so two towers of
                // identical size still light different windows.
                OUT.seed = frac(dot(unity_ObjectToWorld._m03_m13_m23,
                                    float3(0.0731, 0.1379, 0.0517)));

                VertexPositionInputs pos = GetVertexPositionInputs(IN.positionOS.xyz);
                OUT.positionCS = pos.positionCS;
                OUT.positionWS = pos.positionWS;
                OUT.normalWS   = TransformObjectToWorldNormal(IN.normalOS);
                OUT.fogCoord   = ComputeFogFactor(pos.positionCS.z);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(IN);

                float3 an = abs(IN.normalOS);
                bool isWall = an.y < 0.5;

                // Horizontal axis runs along whichever face we are on; the
                // vertical axis is *world* Y, so floor lines run continuously
                // across the separate boxes that make up one tiered tower.
                float u = (an.x > 0.5) ? IN.facadeLocal.z : IN.facadeLocal.x;
                float worldY = IN.positionWS.y;

                float2 cell = float2(u / _BayW, worldY / _FloorH);
                float2 id = floor(cell);
                float2 g = frac(cell);

                float px = smoothstep(0.13, 0.17, g.x) * (1.0 - smoothstep(0.83, 0.87, g.x));
                float py = smoothstep(0.17, 0.21, g.y) * (1.0 - smoothstep(0.74, 0.78, g.y));
                float glass = px * py;

                float mullion = 1.0 - smoothstep(0.03, 0.07, abs(g.x - 0.5) - 0.42);
                float slab    = 1.0 - smoothstep(0.02, 0.06, abs(g.y - 0.9) - 0.06);

                // Reveal: lit under the head of the window, shadowed above the
                // sill. Reads as a recessed pane without a normal map.
                float reveal = smoothstep(0.78, 0.72, g.y) * smoothstep(0.66, 0.74, g.y)
                             - smoothstep(0.17, 0.23, g.y) * smoothstep(0.29, 0.23, g.y);

                float cellRand  = FacadeHash(id + IN.seed * 37.1);
                float floorRand = FacadeHash(float2(id.y, IN.seed * 71.3));
                float floorLit  = step(0.86, floorRand);
                float lit = max(step(0.62, cellRand), floorLit * step(0.25, cellRand));

                float pick = FacadeHash(id.yx + IN.seed * 11.7);
                float3 litColor = pick < 0.4 ? float3(0.78, 0.96, 0.90)
                                : (pick < 0.75 ? float3(0.62, 0.83, 1.00)
                                               : float3(0.76, 0.71, 1.00));
                litColor *= 1.0 + step(0.93, FacadeHash(id + IN.seed * 5.3)) * 0.7;

                // Ground-floor shopfronts, confined to roughly one storey.
                // Spilling this over two storeys made every building wear a
                // solid white band at eye level.
                float podium = (1.0 - smoothstep(_FloorH * 0.8, _FloorH * 1.4, worldY))
                             * (0.45 + 0.55 * step(0.35, cellRand));

                float3 albedo = _Concrete.rgb;
                float roughness = 0.85;
                float metallic = 0.05;
                float3 emission = 0.0;

                if (isWall)
                {
                    float3 spandrel  = albedo * 0.82;
                    float3 structure = albedo * 1.22;
                    float3 glassTint = float3(0.035, 0.055, 0.10);

                    albedo = lerp(lerp(spandrel, structure, max(mullion, slab)), glassTint, glass);
                    albedo *= 1.0 + reveal * 0.55;
                    // Street grime rising off the pavement.
                    albedo *= lerp(0.55, 1.0, smoothstep(0.0, 14.0, worldY));

                    // The split a texture cannot express: glass is smooth and
                    // metallic and mirrors the probe, concrete stays rough.
                    roughness = lerp(roughness, 0.08, glass);
                    metallic  = lerp(metallic, 0.9, glass);

                    float on = max(lit, podium * 0.8);
                    float3 tint = UNITY_ACCESS_INSTANCED_PROP(Props, _WindowTint).rgb;
                    emission = litColor * glass * on * tint * _EmissiveMul;
                    emission += litColor * slab * on * 0.05;
                }
                else
                {
                    albedo *= 0.7;   // roof decks
                }

                InputData inputData = (InputData)0;
                inputData.positionWS = IN.positionWS;
                inputData.normalWS = normalize(IN.normalWS);
                inputData.viewDirectionWS = GetWorldSpaceNormalizeViewDir(IN.positionWS);
                inputData.shadowCoord = TransformWorldToShadowCoord(IN.positionWS);
                inputData.fogCoord = IN.fogCoord;
                inputData.bakedGI = SampleSH(inputData.normalWS);

                SurfaceData surface = (SurfaceData)0;
                surface.albedo = albedo;
                surface.metallic = metallic;
                surface.smoothness = 1.0 - roughness;
                surface.emission = emission;
                surface.occlusion = 1.0;
                surface.alpha = 1.0;

                half4 color = UniversalFragmentPBR(inputData, surface);
                color.rgb = MixFog(color.rgb, IN.fogCoord);
                return color;
            }
            ENDHLSL
        }

        // Shadow casting reuses URP's stock pass; the facade is opaque, so
        // there is nothing procedural to account for in the depth-only pass.
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
        UsePass "Universal Render Pipeline/Lit/DepthOnly"
    }
    FallBack "Universal Render Pipeline/Lit"
}
