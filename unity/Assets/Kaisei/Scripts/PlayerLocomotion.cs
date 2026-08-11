using System;
using System.Collections.Generic;
using UnityEngine;

namespace Kaisei
{
    /// <summary>
    /// Locomotion, collision and comfort, ported from src/player/player.js.
    ///
    /// Deliberately does NOT read controllers. Raw gamepad/axis polling is
    /// exactly the part of the JS file that is WebXR plumbing rather than a
    /// design decision — see unity/README.md — and belongs to the XR
    /// Interaction Toolkit's action-based input instead. This script owns
    /// only what XRITK does not ship out of the box: snapping to a
    /// hand-authored platform/ramp height field (the city's stacked-box
    /// geometry has no navmesh), resolving into hand-authored box colliders,
    /// the seat mechanic, and a movement-eased comfort vignette. Whatever
    /// drives XR input calls <see cref="Tick"/> once a frame with already
    /// resolved move/turn/sit intent.
    ///
    /// A genuine port hazard lives in <see cref="Tick"/>: three.js is
    /// right-handed, Unity is left-handed. The original JS derives "right"
    /// as `crossVectors(forward, up)` then negates it; transliterating that
    /// literally into `Vector3.Cross(forward, up)` would silently swap left
    /// and right underfoot in Unity, because the same cross-product formula
    /// means the opposite thing in the two conventions. The fix is to swap
    /// the operand order (`Cross(up, forward)`), not to negate the result —
    /// verified by hand for the axis-aligned case (forward = +Z should give
    /// right = +X) since there is no Unity runtime here to check it against.
    /// Confirm sideways movement points the right way the first time this
    /// runs in the editor.
    ///
    /// NOT compiled against a real Unity install — see unity/README.md.
    /// </summary>
    public class PlayerLocomotion : MonoBehaviour
    {
        [Header("Rig")]
        [Tooltip("Moved directly, same as the WebXR build's rig group. Never the camera itself.")]
        public Transform rig;
        [Tooltip("The XR Origin's camera. Read only, to derive facing and head position.")]
        public Transform head;

        [Header("Comfort")]
        public float speed = 3.0f;
        [Range(0f, 1f)] public float vignetteStrength = 0.55f;
        public float snapAngleDeg = 30f;
        [Tooltip("Seconds a snap turn is locked out after firing, so one deflection is one snap.")]
        public float snapCooldownSeconds = 0.28f;

        [Header("Collision")]
        [Tooltip("Player capsule radius against the city's box colliders.")]
        public float radius = 0.32f;
        [Tooltip("Fall acceleration, m/s^2, when the ground drops away underfoot.")]
        public float gravity = 18f;

        public struct Platform { public float minX, maxX, minZ, maxZ, y; }
        public struct Ramp { public float minX, maxX, minZ, maxZ; public Func<float, float> yAt; }
        public struct BoxCollider2D { public float minX, maxX, minZ, maxZ; }
        public struct Seat { public float x, y, z; }

        public readonly List<Platform> platforms = new List<Platform>();
        public readonly List<Ramp> ramps = new List<Ramp>();
        public readonly List<BoxCollider2D> colliders = new List<BoxCollider2D>();
        public readonly List<Seat> seats = new List<Seat>();

        public bool Seated { get; private set; }
        public float VignetteAlpha { get; private set; }

        Vector3 _standPos;
        float _moveAmount;
        float _snapCooldown;
        float _velocityY;

        /// <summary>Highest walkable surface under (x, z).</summary>
        public float GroundHeight(float x, float z)
        {
            float y = 0f;
            foreach (var p in platforms)
                if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ)
                    y = Mathf.Max(y, p.y);
            foreach (var r in ramps)
                if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ)
                    y = Mathf.Max(y, r.yAt(z));
            return y;
        }

        /// <summary>Push a position out of any collider it has entered, along the shallowest axis.</summary>
        public void ResolveCollisions(ref Vector3 pos)
        {
            foreach (var c in colliders)
            {
                float minX = c.minX - radius, maxX = c.maxX + radius;
                float minZ = c.minZ - radius, maxZ = c.maxZ + radius;
                if (pos.x < minX || pos.x > maxX || pos.z < minZ || pos.z > maxZ) continue;

                float dl = pos.x - minX, dr = maxX - pos.x;
                float db = pos.z - minZ, df = maxZ - pos.z;
                float m = Mathf.Min(Mathf.Min(dl, dr), Mathf.Min(db, df));
                if (m == dl) pos.x = minX;
                else if (m == dr) pos.x = maxX;
                else if (m == db) pos.z = minZ;
                else pos.z = maxZ;
            }
        }

        /// <summary>Trigger near a cushion sits you down; trigger again stands you up.</summary>
        public void TrySit()
        {
            if (Seated) { Stand(); return; }

            Vector3 h = head.position;
            Seat? best = null;
            float bestD = 1.6f;
            foreach (var s in seats)
            {
                float dx = s.x - h.x, dz = s.z - h.z;
                float d = Mathf.Sqrt(dx * dx + dz * dz);
                if (d < bestD) { bestD = d; best = s; }
            }
            if (best.HasValue) Sit(best.Value);
        }

        void Sit(Seat seat)
        {
            Seated = true;
            _standPos = rig.position;
            // Offset by the head's local XZ so the player's body lands on the
            // cushion rather than the rig origin, which may be metres away
            // in roomscale.
            Vector3 h = head.position;
            Vector3 p = rig.position;
            p.x += seat.x - h.x;
            p.z += seat.z - h.z;
            p.y = seat.y - 0.45f;   // seated eye height offset
            rig.position = p;
        }

        void Stand()
        {
            Seated = false;
            rig.position = _standPos;
        }

        /// <summary>
        /// Advance one frame. moveX/moveZ/turnX come pre-resolved from
        /// whatever input system is wired up (XRITK action, desktop keys);
        /// this method never touches a controller or a keyboard itself.
        /// </summary>
        public void Tick(float dt, float moveX, float moveZ, float turnX, bool sitPressed)
        {
            _snapCooldown = Mathf.Max(0f, _snapCooldown - dt);

            // Snap turn. Never smooth — smooth yaw is the single most
            // reliable way to make a player in a headset feel ill.
            if (Mathf.Abs(turnX) > 0.7f && _snapCooldown <= 0f)
            {
                float sign = turnX > 0f ? 1f : -1f;
                rig.RotateAround(head.position, Vector3.up, -sign * snapAngleDeg);
                _snapCooldown = snapCooldownSeconds;
            }

            if (sitPressed) TrySit();

            if (Seated)
            {
                _moveAmount = 0f;
                VignetteAlpha = 0f;
                return;
            }

            // Move relative to gaze direction, matching the WebXR build.
            Vector3 forward = head.forward;
            forward.y = 0f;
            if (forward.sqrMagnitude < 1e-6f) forward = Vector3.forward;
            forward.Normalize();
            // Cross(up, forward), not Cross(forward, up) — see the class
            // comment on the handedness swap this port needed.
            Vector3 right = Vector3.Cross(Vector3.up, forward);
            right.Normalize();

            Vector3 step = forward * (-moveZ) + right * moveX;
            float mag = Mathf.Min(Mathf.Sqrt(step.x * step.x + step.z * step.z), 1f);
            if (mag > 0.001f)
            {
                float invLen = mag > 0f ? 1f / Mathf.Sqrt(step.x * step.x + step.z * step.z) : 0f;
                Vector3 next = rig.position + step * (invLen * speed * mag * dt);
                ResolveCollisions(ref next);
                Vector3 p = rig.position;
                p.x = next.x;
                p.z = next.z;
                rig.position = p;
            }

            // Vertical: snap to the surface underfoot, with a short fall if
            // it drops away.
            Vector3 headPos = head.position;
            float target = GroundHeight(headPos.x, headPos.z);
            float dy = target - rig.position.y;
            Vector3 rp = rig.position;
            if (dy > 0f)
            {
                rp.y = target;              // step up instantly
                _velocityY = 0f;
            }
            else if (dy < -0.02f)
            {
                _velocityY -= gravity * dt;
                rp.y = Mathf.Max(target, rp.y + _velocityY * dt);
                if (rp.y == target) _velocityY = 0f;
            }
            rig.position = rp;

            // Vignette tracks actual movement, eased so it never pops. Same
            // exponential damp as THREE.MathUtils.damp: approach the target
            // at a rate proportional to the remaining distance, independent
            // of frame rate.
            _moveAmount += (mag - _moveAmount) * (1f - Mathf.Exp(-8f * dt));
            VignetteAlpha = _moveAmount * vignetteStrength;
        }
    }
}
