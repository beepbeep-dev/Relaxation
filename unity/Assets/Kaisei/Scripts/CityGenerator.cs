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

        // Resolved once. Looking a property up by string every frame hashes the
        // string every frame.
        static readonly int WindowTintId = Shader.PropertyToID("_WindowTint");

        struct Tower
        {
            public Vector3 pos;
            public float w, d, h, roof;
            public Color tint;
        }

        readonly List<Matrix4x4> _towerParts = new List<Matrix4x4>();
        readonly List<Vector4> _towerTints = new List<Vector4>();
        readonly List<Matrix4x4> _parapets = new List<Matrix4x4>();
        readonly List<Bounds> _colliders = new List<Bounds>();

        // Batches are sliced once at generation time and reused every frame.
        // The first version called List.GetRange().ToArray() twice per batch
        // inside Update, which allocates on every single frame — the exact
        // thing the JavaScript build was rewritten to stop doing, because GC
        // pauses on a mobile chip read as hitches in a headset.
        struct Batch
        {
            public Matrix4x4[] matrices;
            public Vector4[] tints;
            public int count;
        }
        readonly List<Batch> _towerBatches = new List<Batch>();
        readonly List<Batch> _parapetBatches = new List<Batch>();

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

            Slice(_towerParts, _towerTints, _towerBatches);
            Slice(_parapets, null, _parapetBatches);
        }

        static void Slice(List<Matrix4x4> matrices, List<Vector4> tints, List<Batch> into)
        {
            for (int start = 0; start < matrices.Count; start += BatchLimit)
            {
                int count = Mathf.Min(BatchLimit, matrices.Count - start);
                into.Add(new Batch
                {
                    matrices = matrices.GetRange(start, count).ToArray(),
                    tints = tints?.GetRange(start, count).ToArray(),
                    count = count,
                });
            }
        }

        void AddPart(Vector3 centre, Vector3 size, Color tint)
        {
            _towerParts.Add(Matrix4x4.TRS(centre, Quaternion.identity, size));
            _towerTints.Add(tint);
        }

        /// <summary>A thin slab overhanging a tier top — the roof's edge.</summary>
        void AddCap(Vector3 at, float w, float d)
        {
            _parapets.Add(Matrix4x4.TRS(
                at + Vector3.up * 0.22f, Quaternion.identity, new Vector3(w, 0.44f, d)));
        }

        /// <summary>Split one building into podium, shaft tiers and crown.</summary>
        void Decompose(Tower t)
        {
            float podiumH = Mathf.Min(7.2f, t.h * 0.28f);
            AddPart(t.pos + Vector3.up * podiumH * 0.5f,
                new Vector3(t.w * 1.14f, podiumH, t.d * 1.14f), t.tint);
            AddCap(t.pos + Vector3.up * podiumH, t.w * 1.2f, t.d * 1.2f);

            int tiers = 1 + _rng.Next(3);
            float baseY = podiumH, remaining = t.h - podiumH, sw = t.w, sd = t.d;

            for (int i = 0; i < tiers && remaining > 3f; i++)
            {
                bool last = i == tiers - 1;
                float tierH = last ? remaining : remaining * Range(0.4f, 0.7f);
                AddPart(t.pos + Vector3.up * (baseY + tierH * 0.5f),
                    new Vector3(sw, tierH, sd), t.tint);
                baseY += tierH;
                remaining -= tierH;
                if (!last)
                {
                    AddCap(t.pos + Vector3.up * baseY, sw * 1.06f, sd * 1.06f);
                    float step = Range(0.72f, 0.9f);
                    sw *= step; sd *= step;
                }
            }

            if (t.h > 34f)
            {
                float crownH = Range(2.5f, 6f);
                AddPart(t.pos + Vector3.up * (baseY + crownH * 0.5f),
                    new Vector3(sw * 0.62f, crownH, sd * 0.62f), t.tint);
                baseY += crownH;
            }
            AddCap(t.pos + Vector3.up * baseY, sw * 1.08f, sd * 1.08f);

            // Collision uses the podium, the widest part at walking height.
            _colliders.Add(new Bounds(
                t.pos + Vector3.up * podiumH * 0.5f,
                new Vector3(t.w * 1.14f, podiumH, t.d * 1.14f)));
        }

        void Update()
        {
            DrawBatches(_towerBatches, facadeMaterial);
            DrawBatches(_parapetBatches, parapetMaterial);
        }

        void DrawBatches(List<Batch> batches, Material material)
        {
            if (material == null) return;

            foreach (var b in batches)
            {
                _mpb.Clear();
                if (b.tints != null) _mpb.SetVectorArray(WindowTintId, b.tints);

                Graphics.DrawMeshInstanced(
                    _cube, 0, material, b.matrices, b.count, _mpb,
                    UnityEngine.Rendering.ShadowCastingMode.On, true);
            }
        }

        public IReadOnlyList<Bounds> Colliders => _colliders;

        /// <summary>
        /// A unit cube with split vertices, so each face carries its own normal.
        ///
        /// Built by hand rather than via GameObject.CreatePrimitive: that call
        /// spawns a real GameObject complete with a BoxCollider purely to read
        /// its mesh back, and then has to destroy it — wasteful, and it leaves a
        /// collider in the scene for a frame if the destroy is ever missed.
        ///
        /// Split vertices matter for the facade shader, which switches on the
        /// object-space normal to decide whether a fragment is a wall or a roof.
        /// A shared-vertex cube interpolates normals across the corners and the
        /// wall/roof test flickers along every edge.
        /// </summary>
        static Mesh BuildCube()
        {
            var verts = new List<Vector3>();
            var norms = new List<Vector3>();
            var tris = new List<int>();

            const float h = 0.5f;
            Face(verts, norms, tris, Vector3.forward, new Vector3(-h, -h, h), new Vector3(h, -h, h), new Vector3(h, h, h), new Vector3(-h, h, h));
            Face(verts, norms, tris, Vector3.back, new Vector3(h, -h, -h), new Vector3(-h, -h, -h), new Vector3(-h, h, -h), new Vector3(h, h, -h));
            Face(verts, norms, tris, Vector3.right, new Vector3(h, -h, h), new Vector3(h, -h, -h), new Vector3(h, h, -h), new Vector3(h, h, h));
            Face(verts, norms, tris, Vector3.left, new Vector3(-h, -h, -h), new Vector3(-h, -h, h), new Vector3(-h, h, h), new Vector3(-h, h, -h));
            Face(verts, norms, tris, Vector3.up, new Vector3(-h, h, h), new Vector3(h, h, h), new Vector3(h, h, -h), new Vector3(-h, h, -h));
            Face(verts, norms, tris, Vector3.down, new Vector3(-h, -h, -h), new Vector3(h, -h, -h), new Vector3(h, -h, h), new Vector3(-h, -h, h));

            var m = new Mesh { name = "Kaisei/UnitCube" };
            m.SetVertices(verts);
            m.SetNormals(norms);
            m.SetTriangles(tris, 0);
            m.RecalculateBounds();
            return m;
        }

        static void Face(List<Vector3> verts, List<Vector3> norms, List<int> tris,
                         Vector3 normal, Vector3 a, Vector3 b, Vector3 c, Vector3 d)
        {
            int i = verts.Count;
            verts.Add(a); verts.Add(b); verts.Add(c); verts.Add(d);
            for (int k = 0; k < 4; k++) norms.Add(normal);
            tris.Add(i); tris.Add(i + 1); tris.Add(i + 2);
            tris.Add(i); tris.Add(i + 2); tris.Add(i + 3);
        }
    }
}
