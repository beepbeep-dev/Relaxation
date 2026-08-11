using System;
using System.Collections.Generic;
using UnityEngine;

namespace Kaisei
{
    /// <summary>
    /// STEEL GARDEN's combat rules, ported from src/games/sword.js. Endless
    /// sword fighting until you die: humanoid opponents walk at you, you cut
    /// them by actually swinging (blade speed matters, resting the blade on
    /// someone does nothing), they cut you back if you do not block, and it
    /// does not stop.
    ///
    /// This is the state machine and the numbers only — spawning positions,
    /// health, strike resolution, the approach/windup/strike/recover/falling
    /// cycle. It deliberately does NOT include per-limb pose math (the JS
    /// version's `_poseEnemy`, which drives eight InstancedMesh pools): that
    /// is Unity-side rendering plumbing that depends on decisions not made
    /// yet (GPU instancing via Graphics.DrawMeshInstanced like
    /// CityGenerator.cs, or the Animation Rigging package, or simple
    /// per-enemy Animator instances) and belongs in a follow-up once one of
    /// those is chosen. Whatever presentation layer gets built reads
    /// <see cref="Enemies"/> each frame the same way the JS renderer does.
    ///
    /// One thing carried over on purpose rather than rediscovered: enemies
    /// steer straight at the player's actual head position every frame
    /// (<see cref="UpdateEnemies"/>). An earlier version of the JS file
    /// shrank a radius about the arena's origin instead of the player's
    /// position, so off-centre players watched opponents converge on empty
    /// space and stop — a real, shipped, player-reported bug. There is no
    /// reason to leave that mistake available to make twice.
    ///
    /// NOT compiled against a real Unity install — see unity/README.md.
    /// </summary>
    public class SwordCombat : MonoBehaviour
    {
        public const float ArenaRadius = 7.0f;
        public const float FrontArc = 0.7f * (float)Math.PI;  // enemies only spawn in front — seated-viable
        public const int MaxEnemies = 8;                       // fixed pool, for a future instanced renderer

        public const float StrikeRange = 1.9f;
        public const float Windup = 0.85f;      // seconds with the sword raised before it falls
        public const float Recover = 0.7f;
        public const float BlockRadius = 0.45f; // how close your blade must be to theirs
        public const float KillSpeed = 2.6f;    // m/s of blade tip needed to cut, not nudge
        public const int StartHealth = 5;

        public enum EnemyState { Approach, Windup, Strike, Recover, Falling }

        public class Enemy
        {
            public int Slot;
            public Vector3 Pos;
            public float Speed;
            public EnemyState State;
            public float Timer;
            public float Gait;
            public float Swing;
            public float Fall;
            public int Hp;
            public float Knockback;
            public float Yaw;
        }

        public readonly List<Enemy> Enemies = new List<Enemy>();

        public int Wave { get; private set; } = 1;
        public int Kills { get; private set; }
        public int Score { get; private set; }
        public int Health { get; private set; } = StartHealth;
        public bool Dead { get; private set; }

        readonly Random _rand = new Random(5150);
        float _spawnTimer;

        public void Enter()
        {
            Enemies.Clear();
            Wave = 1;
            Kills = 0;
            Score = 0;
            Health = StartHealth;
            Dead = false;
            _spawnTimer = 0f;
        }

        float RandRange(float lo, float hi) => lo + (float)_rand.NextDouble() * (hi - lo);

        /// <summary>
        /// Call once a frame while fighting, before UpdateEnemies. The
        /// pressure never stops, it only grows: wave count tracks kills, and
        /// the spawn interval shortens as the wave rises.
        /// </summary>
        public void MaybeSpawn(float dt)
        {
            int target = Mathf.Min(2 + Wave / 2, MaxEnemies);
            _spawnTimer -= dt;
            if (_spawnTimer <= 0f && Enemies.Count < target)
            {
                SpawnEnemy();
                _spawnTimer = Mathf.Max(0.7f, 2.4f - Wave * 0.14f);
            }
        }

        public Enemy SpawnEnemy()
        {
            if (Enemies.Count >= MaxEnemies) return null;
            var used = new HashSet<int>();
            foreach (var e in Enemies) used.Add(e.Slot);
            int slot = 0;
            while (used.Contains(slot)) slot++;

            float angle = RandRange(-FrontArc, FrontArc);
            float spawnR = ArenaRadius - 0.5f;
            var enemy = new Enemy
            {
                Slot = slot,
                Speed = 0.9f + Wave * 0.08f + RandRange(-0.15f, 0.25f),
                State = EnemyState.Approach,
                Timer = 0f,
                Gait = RandRange(0f, 2f * (float)Math.PI),
                Swing = 0f,
                Fall = 0f,
                Hp = Wave > 4 ? 2 : 1,
                // Position is authoritative and steers straight at the player's
                // actual head position (see UpdateEnemies) — not at the arena
                // origin. See the class comment.
                Pos = new Vector3(Mathf.Sin(angle) * spawnR, 0f, -Mathf.Cos(angle) * spawnR),
            };
            Enemies.Add(enemy);
            return enemy;
        }

        void RemoveEnemy(Enemy e) => Enemies.Remove(e);

        /// <summary>
        /// One frame of the whole fight. headLocal is the player's head
        /// position in the arena's local space (mirrors the JS file bringing
        /// the head into arena space once via worldToLocal, rather than
        /// pushing every enemy out into world space). bladeTipLocal and
        /// bladeTipSpeed describe the player's own blade for the player-cuts-
        /// enemy check; blockCheck is called per enemy during their strike to
        /// resolve block-vs-hit against wherever the *player's* blade already
        /// is (kept as a delegate rather than a hard Transform dependency, so
        /// this class stays presentation-agnostic).
        /// </summary>
        public void UpdateEnemies(float dt, Vector3 headLocal, Vector3 bladeTipLocal,
            float bladeTipSpeed, Func<Vector3, float> distanceToPlayerBlade)
        {
            foreach (var e in new List<Enemy>(Enemies))
            {
                if (e.State == EnemyState.Falling)
                {
                    e.Fall += dt * 2.2f;
                    if (e.Fall >= 1f) { RemoveEnemy(e); }
                    continue;
                }

                float dx = headLocal.x - e.Pos.x;
                float dz = headLocal.z - e.Pos.z;
                float distance = Mathf.Sqrt(dx * dx + dz * dz);
                if (distance <= 0f) distance = 1e-4f;
                e.Yaw = Mathf.Atan2(dx, dz);

                switch (e.State)
                {
                    case EnemyState.Approach:
                        if (distance > StrikeRange)
                        {
                            float stepLen = Mathf.Min(e.Speed * dt, distance - StrikeRange);
                            e.Pos = new Vector3(
                                e.Pos.x + (dx / distance) * stepLen, e.Pos.y,
                                e.Pos.z + (dz / distance) * stepLen);
                            e.Gait += dt * e.Speed * 5.5f;
                        }
                        else
                        {
                            e.State = EnemyState.Windup;
                            e.Timer = 0f;
                            e.Swing = 0f;
                        }
                        break;

                    case EnemyState.Windup:
                        e.Timer += dt;
                        e.Swing = 0f;
                        if (e.Timer >= Windup) { e.State = EnemyState.Strike; e.Timer = 0f; }
                        break;

                    case EnemyState.Strike:
                        e.Timer += dt;
                        e.Swing = Mathf.Min(1f, e.Timer / 0.16f);
                        if (e.Swing >= 1f)
                        {
                            ResolveEnemyStrike(e, headLocal, distance, distanceToPlayerBlade);
                            e.State = EnemyState.Recover;
                            e.Timer = 0f;
                        }
                        break;

                    case EnemyState.Recover:
                        e.Timer += dt;
                        e.Swing = Mathf.Max(0f, 1f - e.Timer / Recover);
                        if (e.Timer >= Recover)
                        {
                            e.State = EnemyState.Approach;
                            StepBack(e, headLocal, 0.7f);
                        }
                        break;
                }

                // Your cut. Needs speed -- resting the blade on someone does nothing.
                var chest = new Vector3(e.Pos.x, 1.05f, e.Pos.z);
                if (distanceToPlayerBlade(chest) < 0.55f && bladeTipSpeed > KillSpeed) Cut(e);
                if (e.Knockback != 0f) { StepBack(e, headLocal, e.Knockback); e.Knockback = 0f; }
            }
        }

        /// <summary>Push an opponent directly away from the player, staying inside the arena.</summary>
        void StepBack(Enemy e, Vector3 headLocal, float amount)
        {
            float dx = e.Pos.x - headLocal.x;
            float dz = e.Pos.z - headLocal.z;
            float d = Mathf.Sqrt(dx * dx + dz * dz);
            if (d <= 0f) d = 1e-4f;
            float nx = e.Pos.x + (dx / d) * amount;
            float nz = e.Pos.z + (dz / d) * amount;
            float r = Mathf.Sqrt(nx * nx + nz * nz);
            if (r > ArenaRadius - 0.5f)
            {
                float k = (ArenaRadius - 0.5f) / r;
                nx *= k; nz *= k;
            }
            e.Pos = new Vector3(nx, e.Pos.y, nz);
        }

        /// <summary>
        /// Their blade comes down. Block is positional: your sword has to be
        /// near where theirs lands, not an angle puzzle -- the thing every
        /// player instinctively tries to do anyway.
        /// </summary>
        void ResolveEnemyStrike(Enemy e, Vector3 headLocal, float distance,
            Func<Vector3, float> distanceToPlayerBlade)
        {
            float dx = headLocal.x - e.Pos.x;
            float dz = headLocal.z - e.Pos.z;
            float d = Mathf.Sqrt(dx * dx + dz * dz);
            if (d <= 0f) d = 1f;
            // Where their sword ends the swing: in front of them, at chest
            // height, on the line towards the player.
            var impact = new Vector3(e.Pos.x + (dx / d) * 0.9f, 1.15f, e.Pos.z + (dz / d) * 0.9f);

            if (distanceToPlayerBlade(impact) < BlockRadius)
            {
                Score += 15;
                // Blocked-hit VFX (blade flashing green) is presentation, not
                // combat state — left to whatever drives the blade material.
            }
            else if (distance < StrikeRange + 0.6f)
            {
                Health--;
                if (Health <= 0) Die();
            }
        }

        void Cut(Enemy e)
        {
            e.Hp--;
            if (e.Hp > 0)
            {
                // Staggered: knocked out of whatever they were doing, pushed back.
                e.State = EnemyState.Recover;
                e.Timer = 0f;
                e.Knockback = 0.9f;
                Score += 25;
                return;
            }
            e.State = EnemyState.Falling;
            e.Fall = 0f;
            Kills++;
            Score += 100;

            // Waves ramp with kills. The pressure never stops, it only grows.
            Wave = 1 + Kills / 5;
        }

        void Die()
        {
            Dead = true;
        }
    }
}
