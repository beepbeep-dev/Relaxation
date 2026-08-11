using System.Collections.Generic;
using UnityEngine;

namespace Kaisei
{
    /// <summary>
    /// Kaisei's street level, ported from src/world/city.js.
    ///
    /// Two rules govern the whole thing, and both survive the move to Unity
    /// unchanged because they are properties of the hardware, not the engine:
    ///
    ///  1. Draw calls are the budget, not triangles. A tile-based mobile GPU
    ///     cares far more about how many times you ask it to draw than about
    ///     how much you draw. Everything repeated goes through
    ///     Graphics.DrawMeshInstanced.
    ///
    ///  2. Buildings are composed from stacked boxes, not single scaled cubes.
    ///     A wider street-level podium, one to three shaft tiers stepping back
    ///     as they rise, and a crown on the tall ones. Setbacks are what make a
    ///     skyline read as architecture rather than as a bar chart, and since
    ///     every box is an instance of the same mesh they cost nothing.
    ///
    /// NOT compiled or run — see unity/README.md.
    /// </summary>
    public class CityGenerator : MonoBehaviour
    {
        [Header("Grid")]
        [Tooltip("Metres between street centrelines.")]
        public float block = 42f;
        [Tooltip("Street width. The race circuit runs down these.")]
        public float street = 14f;
        [Range(4, 14)] public int cityBlocks = 8;

        [Header("Look")]
        public Material facadeMaterial;
        public Material parapetMaterial;
        [Range(0.2f, 1.5f)] public float propDensity = 0.7f;

        [Header("Determinism")]
        [Tooltip("The city is identical on every boot and every device.")]
        public int seed = 20260811;

        // DrawMeshInstanced caps at 1023 per call; batches are split to match.
        const int BatchLimit = 1023;

        struct Tower
        {
            public Vector3 pos;
            public float w, d, h, roof;
            public Color tint;
        }

        readonly List<Matrix4x4> _towerParts = new();
        readonly List<Vector4> _towerTints = new();
        readonly List<Matrix4x4> _parapets = new();
        readonly List<Bounds> _colliders = new();

        Mesh _cube;
        System.Random _rng;
        MaterialPropertyBlock _mpb;

        float Range(float a, float b) => a + (float)_rng.NextDouble() * (b - a);
        float BlockCoord(int i) => (i - (cityBlocks - 1) * 0.5f) * block;

        void Awake()
        {
            _rng = new System.Random(seed);
            _cube = BuildCube();
            _mpb = new MaterialPropertyBlock();
            Generate();
        }

        void Generate()
        {
            var towers = new List<Tower>();
            float keepout = block * 1.2f;   // the plaza the player spawns into

            for (int bx = 0; bx < cityBlocks; bx++)
            for (int bz = 0; bz < cityBlocks; bz++)
            {
                float cx = BlockCoord(bx), cz = BlockCoord(bz);
                if (Mathf.Sqrt(cx * cx + cz * cz) < keepout) continue;

                int count = 2 + _rng.Next(3);
                float usable = block - street;
                for (int k = 0; k < count; k++)
                {
                    float w = Range(9f, usable * 0.55f);
                    float d = Range(9f, usable * 0.55f);
                    float distance = Mathf.Sqrt(cx * cx + cz * cz);
                    // Taller towards the horizon, so the playable streets sit
                    // inside what reads as a downtown core we never built.
                    float h = Range(18f, 40f) + distance * 0.45f;

                    var t = new Tower
                    {
                        pos = new Vector3(
                            cx + Range(-1f, 1f) * (usable * 0.5f - w * 0.5f), 0f,
                            cz + Range(-1f, 1f) * (usable * 0.5f - d * 0.5f)),
                        w = w, d = d, h = h,
                        // Hue restricted to the green->blue->purple arc, so
                        // per-building variation never leaves the palette.
                        tint = Color.HSVToRGB(Range(0.42f, 0.75f), 0.5f, Range(0.55f, 0.9f)),
                    };
                    towers.Add(t);
                }
            }

            foreach (var t in towers) Decompose(t);
        }

        /// <summary>Split one building into podium, shaft tiers and crown.</summary>
        void Decompose(Tower t)
        {
            void Add(Vector3 centre, Vector3 size, Color tint)
            {
                _towerParts.Add(Matrix4x4.TRS(centre, Quaternion.identity, size));
                _towerTints.Add(tint);
            }
            void Cap(Vector3 at, float w, float d)
            {
                _parapets.Add(Matrix4x4.TRS(
                    at + Vector3.up * 0.22f, Quaternion.identity, new Vector3(w, 0.44f, d)));
            }

            float podiumH = Mathf.Min(7.2f, t.h * 0.28f);
            Add(t.pos + Vector3.up * podiumH * 0.5f,
                new Vector3(t.w * 1.14f, podiumH, t.d * 1.14f), t.tint);
            Cap(t.pos + Vector3.up * podiumH, t.w * 1.2f, t.d * 1.2f);

            int tiers = 1 + _rng.Next(3);
            float baseY = podiumH, remaining = t.h - podiumH, sw = t.w, sd = t.d;

            for (int i = 0; i < tiers && remaining > 3f; i++)
            {
                bool last = i == tiers - 1;
                float tierH = last ? remaining : remaining * Range(0.4f, 0.7f);
                Add(t.pos + Vector3.up * (baseY + tierH * 0.5f),
                    new Vector3(sw, tierH, sd), t.tint);
                baseY += tierH;
                remaining -= tierH;
                if (!last)
                {
                    Cap(t.pos + Vector3.up * baseY, sw * 1.06f, sd * 1.06f);
                    float step = Range(0.72f, 0.9f);
                    sw *= step; sd *= step;
                }
            }

            if (t.h > 34f)
            {
                float crownH = Range(2.5f, 6f);
                Add(t.pos + Vector3.up * (baseY + crownH * 0.5f),
                    new Vector3(sw * 0.62f, crownH, sd * 0.62f), t.tint);
                baseY += crownH;
            }
            Cap(t.pos + Vector3.up * baseY, sw * 1.08f, sd * 1.08f);

            // Collision uses the podium, the widest part at walking height.
            _colliders.Add(new Bounds(
                t.pos + Vector3.up * podiumH * 0.5f,
                new Vector3(t.w * 1.14f, podiumH, t.d * 1.14f)));
        }

        void Update()
        {
            DrawBatched(_towerParts, _towerTints, facadeMaterial);
            DrawBatched(_parapets, null, parapetMaterial);
        }

        void DrawBatched(List<Matrix4x4> matrices, List<Vector4> tints, Material material)
        {
            if (material == null || matrices.Count == 0) return;

            for (int start = 0; start < matrices.Count; start += BatchLimit)
            {
                int count = Mathf.Min(BatchLimit, matrices.Count - start);
                var slice = matrices.GetRange(start, count).ToArray();

                _mpb.Clear();
                if (tints != null)
                {
                    _mpb.SetVectorArray("_WindowTint", tints.GetRange(start, count).ToArray());
                }
                Graphics.DrawMeshInstanced(_cube, 0, material, slice, count, _mpb,
                    UnityEngine.Rendering.ShadowCastingMode.On, true);
            }
        }

        public IReadOnlyList<Bounds> Colliders => _colliders;

        /// <summary>A unit cube. Built in code so the port has no asset dependencies.</summary>
        static Mesh BuildCube()
        {
            var m = new Mesh { name = "Kaisei/UnitCube" };
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            var src = go.GetComponent<MeshFilter>().sharedMesh;
            m.vertices = src.vertices;
            m.normals = src.normals;
            m.uv = src.uv;
            m.triangles = src.triangles;
            m.RecalculateBounds();
            if (Application.isPlaying) Destroy(go); else DestroyImmediate(go);
            return m;
        }
    }
}
