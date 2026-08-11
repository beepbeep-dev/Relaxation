// Minimal UnityEngine stand-ins, purely so the port's C# can be run through a
// real compiler on a machine with no Unity install.
//
// WHAT COMPILING AGAINST THIS PROVES
//   The scripts are valid C#: no syntax errors, no undefined symbols, no type
//   mismatches, no bad generic use, every method that is called exists with an
//   arity and argument types that line up.
//
// WHAT IT DOES NOT PROVE
//   That these signatures match Unity 2022.3. They were transcribed by hand
//   from the documented API, so a mistake here becomes a mistake the compiler
//   happily agrees with. This catches the class of error that stops a file
//   compiling at all; it cannot catch "that overload does not exist".
//
// The folder is dot-prefixed so Unity ignores it and never tries to compile
// these definitions alongside the real UnityEngine.
using System.Collections.Generic;

namespace UnityEngine
{
    public struct Vector3
    {
        public float x, y, z;
        public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }

        public static Vector3 up => new Vector3(0, 1, 0);
        public static Vector3 down => new Vector3(0, -1, 0);
        public static Vector3 left => new Vector3(-1, 0, 0);
        public static Vector3 right => new Vector3(1, 0, 0);
        public static Vector3 forward => new Vector3(0, 0, 1);
        public static Vector3 back => new Vector3(0, 0, -1);
        public static Vector3 zero => new Vector3(0, 0, 0);
        public static Vector3 one => new Vector3(1, 1, 1);

        public Vector3 normalized => this;
        public float magnitude => 0f;

        public static Vector3 operator +(Vector3 a, Vector3 b) => new Vector3(a.x + b.x, a.y + b.y, a.z + b.z);
        public static Vector3 operator -(Vector3 a, Vector3 b) => new Vector3(a.x - b.x, a.y - b.y, a.z - b.z);
        public static Vector3 operator *(Vector3 a, float f) => new Vector3(a.x * f, a.y * f, a.z * f);
        public static Vector3 operator *(float f, Vector3 a) => a * f;
        public static Vector3 operator /(Vector3 a, float f) => new Vector3(a.x / f, a.y / f, a.z / f);
    }

    public struct Vector4
    {
        public float x, y, z, w;
        public Vector4(float x, float y, float z, float w) { this.x = x; this.y = y; this.z = z; this.w = w; }
    }

    public struct Color
    {
        public float r, g, b, a;
        public Color(float r, float g, float b, float a = 1f) { this.r = r; this.g = g; this.b = b; this.a = a; }
        public static Color HSVToRGB(float H, float S, float V) => new Color(H, S, V);
        public static implicit operator Vector4(Color c) => new Vector4(c.r, c.g, c.b, c.a);
    }

    public static class ColorUtility
    {
        public static bool TryParseHtmlString(string htmlString, out Color color)
        { color = new Color(0, 0, 0); return true; }
    }

    public struct Quaternion
    {
        public static Quaternion identity => new Quaternion();
    }

    public struct Matrix4x4
    {
        public static Matrix4x4 TRS(Vector3 pos, Quaternion q, Vector3 s) => new Matrix4x4();
    }

    public struct Bounds
    {
        public Bounds(Vector3 center, Vector3 size) { this.center = center; this.size = size; }
        public Vector3 center, size;
    }

    public static class Mathf
    {
        public static float Sqrt(float f) => f;
        public static float Min(float a, float b) => a < b ? a : b;
        public static int Min(int a, int b) => a < b ? a : b;
        public static float Max(float a, float b) => a > b ? a : b;
        public static float Abs(float f) => f < 0 ? -f : f;
        // Unity has both overloads. Omitting the int one sent Abs(int) through
        // the float overload and broke an array index — a stub gap, not a bug
        // in the ported code, and a good illustration of what this check can
        // and cannot tell us.
        public static int Abs(int v) => v < 0 ? -v : v;
        public static int FloorToInt(float f) => (int)f;
        public static float Clamp(float v, float lo, float hi) => v;
        public static float Lerp(float a, float b, float t) => a;
    }

    public class Object
    {
        public string name;
        public static void Destroy(Object o) { }
        public static void DestroyImmediate(Object o) { }
    }

    public class Mesh : Object
    {
        public void SetVertices(List<Vector3> v) { }
        public void SetNormals(List<Vector3> n) { }
        public void SetTriangles(List<int> t, int submesh) { }
        public void RecalculateBounds() { }
    }

    public class Material : Object { }
    public class Component : Object { }
    public class Behaviour : Component { }
    public class MonoBehaviour : Behaviour { }

    public class MaterialPropertyBlock
    {
        public void Clear() { }
        public void SetVectorArray(int nameID, Vector4[] values) { }
        public void SetVectorArray(string name, Vector4[] values) { }
    }

    public static class Shader
    {
        public static int PropertyToID(string name) => 0;
    }

    public static class Graphics
    {
        public static void DrawMeshInstanced(
            Mesh mesh, int submeshIndex, Material material, Matrix4x4[] matrices,
            int count, MaterialPropertyBlock properties,
            Rendering.ShadowCastingMode castShadows, bool receiveShadows) { }
    }

    public static class Application
    {
        public static bool isPlaying => true;
    }

    public class HeaderAttribute : System.Attribute { public HeaderAttribute(string header) { } }
    public class TooltipAttribute : System.Attribute { public TooltipAttribute(string tooltip) { } }
    public class RangeAttribute : System.Attribute { public RangeAttribute(float min, float max) { } }

    namespace Rendering
    {
        public enum ShadowCastingMode { Off, On, TwoSided, ShadowsOnly }
    }
}
