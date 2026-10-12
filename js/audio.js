// Tiny procedural sound effects (no audio files, so the PWA stays small and fully offline).

export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.last = 0;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch (e) {
      this.ctx = null;
    }
  }

  tone(freq, dur, type = 'sine', gain = 0.05, when = 0, slideTo = null) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  play(kind) {
    if (!this.enabled || !this.ctx) return;
    const now = performance.now();
    if (now - this.last < 35) return;
    this.last = now;
    switch (kind) {
      case 'build':
        this.tone(440, 0.09, 'sine', 0.06, 0, 700);
        break;
      case 'place':
        this.tone(520, 0.07, 'triangle', 0.05);
        this.tone(780, 0.1, 'triangle', 0.05, 0.06);
        break;
      case 'remove':
        this.tone(420, 0.12, 'triangle', 0.05, 0, 180);
        break;
      case 'error':
        this.tone(150, 0.14, 'square', 0.035, 0, 110);
        break;
      case 'level':
        this.tone(523, 0.14, 'triangle', 0.06);
        this.tone(659, 0.14, 'triangle', 0.06, 0.12);
        this.tone(784, 0.22, 'triangle', 0.06, 0.24);
        break;
      default:
        break;
    }
  }
}
