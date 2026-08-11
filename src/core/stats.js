/**
 * Frame timing and render counters.
 *
 * Deliberately samples over a one-second window rather than showing an
 * instantaneous figure: a number that flickers every frame is unreadable in a
 * headset, and the thing you actually need to see is the *worst* frame in the
 * window, since that is what a player feels as a stutter.
 */
export class Stats {
  constructor(renderer) {
    this.renderer = renderer;
    this.fps = 0;
    this.worstMs = 0;
    this.calls = 0;
    this.triangles = 0;
    this.programs = 0;

    this._frames = 0;
    this._elapsed = 0;
    this._worst = 0;
  }

  update(dt) {
    this._frames++;
    this._elapsed += dt;
    this._worst = Math.max(this._worst, dt);

    if (this._elapsed >= 1) {
      this.fps = Math.round(this._frames / this._elapsed);
      this.worstMs = Math.round(this._worst * 1000);
      this._frames = 0;
      this._elapsed = 0;
      this._worst = 0;

      const info = this.renderer.info;
      this.calls = info.render.calls;
      this.triangles = info.render.triangles;
      this.programs = info.programs?.length ?? 0;
    }
  }

  line() {
    return `${this.fps} fps · worst ${this.worstMs}ms · ${this.calls} calls · ${(this.triangles / 1000).toFixed(1)}k tris`;
  }
}
