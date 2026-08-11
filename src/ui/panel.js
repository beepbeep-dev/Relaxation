import { SCHEMA, PRESETS } from '../core/settings.js';

/**
 * The 2D graphics settings panel.
 *
 * Used in two places: embedded in the boot screen before entering VR, and as
 * an overlay toggled with Tab on desktop. Inside a headset the wrist panel
 * (see `wrist.js`) takes over, because a DOM overlay is invisible in an XR
 * session.
 *
 * Rows are generated from SCHEMA rather than hand-written, so adding a setting
 * is a one-line change in one file and cannot drift out of sync with what the
 * renderer actually reads.
 */
export class SettingsPanel {
  constructor(settings, { onLiveChange, onReload } = {}) {
    this.settings = settings;
    this.onLiveChange = onLiveChange ?? (() => {});
    this.onReload = onReload ?? (() => location.reload());
    this.el = document.createElement('div');
    this.el.className = 'settings-panel';
    this._controls = new Map();
    this._build();
  }

  _build() {
    const v = this.settings.values;

    const presets = document.createElement('div');
    presets.className = 'sp-presets';
    for (const [key, preset] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.className = 'sp-preset';
      b.dataset.preset = key;
      b.innerHTML = `<strong>${preset.label}</strong><span>${preset.note}</span>`;
      b.onclick = () => {
        this.settings.applyPreset(key);
        this.refresh();
        this.onLiveChange();
      };
      presets.appendChild(b);
    }
    this.el.appendChild(presets);

    const live = document.createElement('div');
    live.className = 'sp-section';
    live.innerHTML = '<h3>Applies immediately</h3>';
    const staged = document.createElement('div');
    staged.className = 'sp-section';
    staged.innerHTML = '<h3>Applies on reload</h3>';

    for (const field of SCHEMA) {
      if (field.kind === 'preset') continue;
      const row = this._row(field, v[field.key]);
      (field.live ? live : staged).appendChild(row);
    }

    this.el.appendChild(live);
    this.el.appendChild(staged);

    this.banner = document.createElement('div');
    this.banner.className = 'sp-banner';
    this.banner.innerHTML =
      '<span>Some changes need a reload.</span><button type="button">Reload now</button>';
    this.banner.querySelector('button').onclick = () => this.onReload();
    this.el.appendChild(this.banner);

    this.refresh();
  }

  _row(field, value) {
    const row = document.createElement('label');
    row.className = 'sp-row';

    const name = document.createElement('span');
    name.className = 'sp-name';
    name.textContent = field.label;
    if (field.help) name.title = field.help;
    row.appendChild(name);

    let input;
    const out = document.createElement('span');
    out.className = 'sp-value';

    if (field.kind === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.onchange = () => this._commit(field, input.checked);
    } else if (field.kind === 'choice') {
      input = document.createElement('select');
      for (const opt of field.options) {
        const o = document.createElement('option');
        o.value = String(opt);
        o.textContent = String(opt);
        input.appendChild(o);
      }
      input.value = String(value);
      input.onchange = () => this._commit(field, Number(input.value));
    } else {
      input = document.createElement('input');
      input.type = 'range';
      input.min = field.min;
      input.max = field.max;
      input.step = field.step;
      input.value = value;
      input.oninput = () => {
        out.textContent = this._format(field, Number(input.value));
        this._commit(field, Number(input.value));
      };
    }

    row.appendChild(input);
    out.textContent = this._format(field, value);
    row.appendChild(out);

    this._controls.set(field.key, { field, input, out });
    return row;
  }

  _format(field, value) {
    if (field.kind === 'bool') return value ? 'on' : 'off';
    if (field.key === 'fogDensity') return value.toFixed(4);
    if (field.key === 'foveation') return value === 0 ? 'off' : `${Math.round(value * 100)}%`;
    if (field.kind === 'range' && field.step < 1) return Number(value).toFixed(2);
    return String(value);
  }

  _commit(field, value) {
    this.settings.set(field.key, value);
    if (field.live) this.onLiveChange();
    this.refresh();
  }

  /** Pull every control back into sync with the store (after a preset click). */
  refresh() {
    const v = this.settings.values;
    for (const [key, { field, input, out }] of this._controls) {
      if (field.kind === 'bool') input.checked = !!v[key];
      else input.value = String(v[key]);
      out.textContent = this._format(field, v[key]);
    }
    for (const b of this.el.querySelectorAll('.sp-preset')) {
      b.classList.toggle('active', b.dataset.preset === v.preset);
    }
    this.banner.classList.toggle('show', this.settings.needsReload);
  }

  mount(parent) { parent.appendChild(this.el); return this; }
}

/**
 * The Tab-toggled overlay used outside XR. Kept separate from the panel itself
 * so the same control list can be embedded in the boot screen without the
 * overlay chrome.
 */
export class SettingsOverlay {
  constructor(panel) {
    this.panel = panel;
    this.el = document.createElement('div');
    this.el.className = 'settings-overlay';
    this.el.innerHTML = '<div class="so-card"><header><h2>Graphics</h2><button type="button" aria-label="Close">×</button></header></div>';
    this.card = this.el.querySelector('.so-card');
    this.el.querySelector('button').onclick = () => this.hide();
    this.el.onclick = (e) => { if (e.target === this.el) this.hide(); };
    document.body.appendChild(this.el);

    addEventListener('keydown', (e) => {
      if (e.code !== 'Tab') return;
      e.preventDefault();
      this.visible ? this.hide() : this.show();
    });
  }

  get visible() { return this.el.classList.contains('show'); }

  show() {
    this.card.appendChild(this.panel.el);
    this.panel.refresh();
    this.el.classList.add('show');
    document.exitPointerLock?.();
  }

  hide() { this.el.classList.remove('show'); }
}
