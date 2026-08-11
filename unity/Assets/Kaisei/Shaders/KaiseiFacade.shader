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
        // Declared here too, not just inside the instancing buffer below, so
        // there is a real default when GPU instancing is off (mobile Vulkan
        // with a single building, the editor's material preview, SRP Batcher
        // compatibility checks). Without a Properties entry of the same name,
        // UNITY_ACCESS_INSTANCED_PROP has nothing to fall back to and every
        // facade goes black instead of tinted.
        _WindowTint ("Window tint (fallback)", Color) = (1, 1, 1, 1)
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
            // Single-pass instanced stereo rendering is the whole reason two
            // eyes cost roughly one draw call on Quest, but it only happens if
            // every stage actually carries the eye index through — see the
            // UNITY_..._STEREO macros below. Missing them does not error, it
            // just quietly renders both eyes from the same one, which reads
            // as a broken headset, not a broken shader.
            #pragma multi_compile_instancing
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _ADDITIONAL_LIGHTS
            #pragma multi_compile _ _SHADOWS_SOFT
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
                UNITY_VERTEX_OUTPUT_STEREO
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
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);

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
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(IN);

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
                // Left zeroed, screen-space occlusion samples every facade
                // fragment at clip-space origin — invisible until SSAO or a
                // decal is added, and a one-line trap for whoever adds one.
                inputData.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(IN.positionCS);
                inputData.shadowMask = half4(1, 1, 1, 1);

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

        // Shadow casting and depth previously came from
        // `UsePass "Universal Render Pipeline/Lit/ShadowCaster"` (and
        // DepthOnly). UsePass name-matches into the *compiled* Lit shader, so
        // it also pulls in Lit's own Attributes/Varyings layout and its
        // _ALPHATEST_ON / _BaseMap property expectations — none of which this
        // shader declares. It happened to work in the versions of URP this
        // was checked against, but a Lit shader rewrite upstream (pass
        // renamed, alpha-clip property required unconditionally) breaks these
        // two passes silently: no compile error, just missing shadows or a
        // broken depth prepass discovered at runtime. Since the facade has no
        // alpha clip and no extra vertex streams, writing the two passes
        // directly against our own Attributes is a few lines and stops
        // depending on Lit's internals at all.
        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }

            ZWrite On
            ZTest LEqual
            ColorMask 0
            Cull Back

            HLSLPROGRAM
            #pragma vertex ShadowVert
            #pragma fragment ShadowFrag
            #pragma target 3.0
            #pragma multi_compile_instancing

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            float3 _LightDirection;

            struct ShadowAttributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct ShadowVaryings
            {
                float4 positionCS : SV_POSITION;
            };

            ShadowVaryings ShadowVert(ShadowAttributes IN)
            {
                ShadowVaryings OUT = (ShadowVaryings)0;
                UNITY_SETUP_INSTANCE_ID(IN);

                float3 positionWS = TransformObjectToWorld(IN.positionOS.xyz);
                float3 normalWS = TransformObjectToWorldNormal(IN.normalOS);
                float4 positionCS = TransformWorldToHClip(
                    ApplyShadowBias(positionWS, normalWS, _LightDirection));

                // Clamp into the light's near plane instead of clipping, same
                // as the stock pass — otherwise shadow casters right at a
                // light's edge pop in and out as they cross it.
#if UNITY_REVERSED_Z
                positionCS.z = min(positionCS.z, positionCS.w * UNITY_NEAR_CLIP_VALUE);
#else
                positionCS.z = max(positionCS.z, positionCS.w * UNITY_NEAR_CLIP_VALUE);
#endif
                OUT.positionCS = positionCS;
                return OUT;
            }

            half4 ShadowFrag(ShadowVaryings IN) : SV_Target { return 0; }
            ENDHLSL
        }

        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode" = "DepthOnly" }

            ZWrite On
            ColorMask 0
            Cull Back

            HLSLPROGRAM
            #pragma vertex DepthOnlyVert
            #pragma fragment DepthOnlyFrag
            #pragma target 3.0
            #pragma multi_compile_instancing

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct DepthAttributes
            {
                float4 positionOS : POSITION;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct DepthVaryings
            {
                float4 positionCS : SV_POSITION;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            DepthVaryings DepthOnlyVert(DepthAttributes IN)
            {
                DepthVaryings OUT = (DepthVaryings)0;
                UNITY_SETUP_INSTANCE_ID(IN);
                UNITY_TRANSFER_INSTANCE_ID(IN, OUT);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(OUT);
                OUT.positionCS = TransformObjectToHClip(IN.positionOS.xyz);
                return OUT;
            }

            half4 DepthOnlyFrag(DepthVaryings IN) : SV_Target { return 0; }
            ENDHLSL
        }
    }
    FallBack "Universal Render Pipeline/Lit"
}
