/**
 * Procedural audio. No sample files — every sound here is synthesised from
 * noise and oscillators at runtime.
 *
 * That is a deliberate trade for this project: a relaxation game lives or dies
 * on its soundscape, but shipping loopable ambient beds costs megabytes and
 * every loop eventually becomes audible as a loop. Filtered noise and detuned
 * drones never repeat, weigh nothing, and can be driven continuously from game
 * state — the rain gets heavier, the wind tracks the throttle.
 *
 * Everything is built lazily on first user gesture, because browsers refuse to
 * start an AudioContext before one.
 */
export class Audio {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.nodes = {};
  }

  /** Must be called from inside a user gesture handler. */
  start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.started = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(this.ctx.destination);
    this._ramp(this.master.gain, 0.7, 4);   // slow fade in, never a hard cut

    this._buildCity();
    this._buildRain();
    this._buildPad();
    this._buildWind();
  }

  _noiseBuffer(seconds = 4) {
    const len = this.ctx.sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Brown noise: integrated white, which sits far lower and reads as weather
    // and traffic rather than as hiss.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }

  _loopNoise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer();
    src.loop = true;
    src.start();
    return src;
  }

  _ramp(param, to, seconds) {
    param.cancelScheduledValues(this.ctx.currentTime);
    param.setValueAtTime(param.value, this.ctx.currentTime);
    param.linearRampToValueAtTime(to, this.ctx.currentTime + seconds);
  }

  /** Distant traffic and machinery: low-passed noise with a slow swell. */
  _buildCity() {
    const src = this._loopNoise();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.22;
    src.connect(lp).connect(gain).connect(this.master);

    // A very slow LFO on the cutoff so the bed breathes instead of sitting flat.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();

    this.nodes.city = gain;
  }

  /** Rain: band-passed noise, gated by the weather toggle. */
  _buildRain() {
    const src = this._loopNoise();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0;
    src.connect(hp).connect(gain).connect(this.master);
    this.nodes.rain = gain;
  }

  /** A slow drone in an open fifth — no melody, nothing to anticipate. */
  _buildPad() {
    const gain = this.ctx.createGain();
    gain.gain.value = 0.05;
    gain.connect(this.master);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.connect(gain);

    // A2, E3, A3 — plus a cent or two of detune so the voices beat slowly
    // against each other instead of sounding synthetic.
    for (const [freq, detune] of [[110, -4], [164.81, 3], [220, 7]]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = this.ctx.createGain();
      g.gain.value = 0.33;
      osc.connect(g).connect(lp);
      osc.start();
    }
    this.nodes.pad = gain;
  }

  /** Race wind: noise whose brightness and level follow craft speed. */
  _buildWind() {
    const src = this._loopNoise();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500;
    bp.Q.value = 0.6;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(bp).connect(gain).connect(this.master);
    this.nodes.wind = gain;
    this.nodes.windFilter = bp;
  }

  setRain(on) {
    if (!this.started) return;
    this._ramp(this.nodes.rain.gain, on ? 0.16 : 0.0, 2.5);
  }

  /** speed01: 0 at rest, 1 at top speed. Called every frame while racing. */
  setSpeed(speed01) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.nodes.wind.gain.setTargetAtTime(speed01 * 0.3, t, 0.15);
    this.nodes.windFilter.frequency.setTargetAtTime(400 + speed01 * 1600, t, 0.15);
  }

  /** Duck the ambience while racing so the two beds do not fight. */
  setRacing(active) {
    if (!this.started) return;
    this._ramp(this.nodes.pad.gain, active ? 0.015 : 0.05, 1.5);
    this._ramp(this.nodes.city.gain, active ? 0.08 : 0.22, 1.5);
  }

  /** A soft blip when a boost gate is taken. Short, and never harsh. */
  ping(freq = 880) {
    if (!this.started) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.55);
  }
}
