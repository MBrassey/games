// Synthesized, Starcraft-flavored UI sound palette.
//
// All sounds are generated at play-time from oscillators + filters + a small
// shared convolution reverb — no audio files, no external assets. Designed
// to stay on the subtle side (peaks around -18 dBFS) so they read as
// interface acknowledgements rather than alerts.
//
// Shape of a "terran UI click" that I was chasing:
//   - short attack (~5 ms), quick decay (~80–120 ms)
//   - bandpass-filtered square or sawtooth (metallic body)
//   - small downward pitch bend over the decay
//   - a low-level noise transient at the very start for the "plastic" snap
//   - tucked into a tiny reverb for spatial glue
//
// Exported API:
//   sound.enable()     — unlock the AudioContext (call inside a user gesture)
//   sound.disable()    — stop the ambient drone
//   sound.isEnabled()  — boolean
//   sound.click()      — primary action confirm-like click
//   sound.hover()      — soft acknowledge
//   sound.confirm()    — two-note ascending ("affirmative")
//   sound.deny()       — two-note descending ("insufficient minerals")
//   sound.notify()     — chat received ping
//   sound.transition() — short filter sweep for page/state changes
//   sound.boot()       — 3-note startup chime
//   sound.key()        — per-keystroke micro-tick

type Ctx = AudioContext;

// --- music generator ---
//
// Procedural ambient score that reads as actual music, not drone: pad
// chords moving through a minor progression, a pentatonic lead that
// arpeggiates over them, a sub-bass pulse on every bar, and rare
// filtered-noise hits for texture. Scheduler uses the Web Audio clock so
// timing stays rock solid regardless of browser/tab throttling.

// Spaceship-casino ambience. Brighter than minor-brood: a lo-fi lounge
// groove in D dorian with jazzy 9/11 colour tones, walking bass, vibraphone
// arpeggios and the occasional bright chime. ~96 bpm, swung feel.
const BPM = 96;
const BEAT = 60 / BPM;
const STEP = BEAT / 2;

// ii–V–I-ish in D dorian with a cheeky chromatic twist. Each chord: bar
// worth of harmony + a bass-line quarter-note pattern over the bar.
// Frequencies are already calculated so we don't do math at schedule time.
const CHORDS: {
  name: string;
  pad: number[];          // sustained chord voicing
  bassWalk: number[];     // 4 quarter-note bass notes
  scale: number[];        // pitches the lead arpeggio pulls from
}[] = [
  {
    // Dm9 — D F A C E
    name: "Dm9",
    pad: [146.83, 220.0, 261.63, 329.63, 440.0],
    bassWalk: [73.42, 82.41, 98.0, 110.0], // D2 E2 G2 A2
    scale: [293.66, 329.63, 349.23, 392.0, 440.0, 523.25, 587.33, 659.25],
  },
  {
    // G13 — G B D F E  (dominant, bright)
    name: "G13",
    pad: [196.0, 246.94, 293.66, 349.23, 440.0],
    bassWalk: [98.0, 110.0, 123.47, 130.81], // G2 A2 B2 C3
    scale: [293.66, 349.23, 392.0, 440.0, 493.88, 587.33, 659.25, 698.46],
  },
  {
    // Cmaj9 — C E G B D
    name: "Cmaj9",
    pad: [130.81, 196.0, 246.94, 293.66, 329.63],
    bassWalk: [65.41, 73.42, 82.41, 98.0], // C2 D2 E2 G2
    scale: [261.63, 293.66, 329.63, 392.0, 440.0, 493.88, 523.25, 587.33],
  },
  {
    // Am11 — A C E G D (cool landing, not resolved)
    name: "Am11",
    pad: [110.0, 164.81, 220.0, 261.63, 392.0],
    bassWalk: [82.41, 98.0, 110.0, 123.47], // E2 G2 A2 B2
    scale: [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33],
  },
];

class SoundEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private musicBus: GainNode | null = null;
  private musicRunning = false;
  private nextScheduleAt = 0; // next beat time (absolute, ctx.currentTime scale)
  private beatIndex = 0;
  private schedulerTimer: number | null = null;
  private enabled = false;
  private lastHover = 0;

  private ensure(): Ctx | null {
    if (typeof window === "undefined") return null;
    if (this.ctx) return this.ctx;
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.55; // global headroom
    master.connect(ctx.destination);
    this.master = master;

    // Tiny convolution reverb — 200 ms decaying noise IR. Glues everything
    // together without sounding like a church.
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 0.2);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = buf;
    const rgain = ctx.createGain();
    rgain.gain.value = 0.22;
    conv.connect(rgain);
    rgain.connect(master);
    this.reverb = conv;

    return ctx;
  }

  // --- lifecycle ---

  isEnabled(): boolean {
    return this.enabled;
  }

  async enable(): Promise<void> {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") await ctx.resume();
    if (!this.enabled) {
      this.enabled = true;
      this.boot();
      this.startMusic();
    }
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.stopMusic();
  }

  // --- internal helpers ---

  private envelope(
    g: GainNode,
    peak: number,
    attack: number,
    decay: number,
    startAt?: number
  ): void {
    const ctx = this.ctx!;
    const t0 = startAt ?? ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  private playOsc(params: {
    freq: number;
    freqEnd?: number;
    type?: OscillatorType;
    attack?: number;
    decay?: number;
    peak?: number;
    filter?: { type: BiquadFilterType; freq: number; Q?: number };
    reverbSend?: number;
    startAt?: number;
    detune?: number;
  }): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = params.startAt ?? ctx.currentTime;
    const dur = (params.attack ?? 0.004) + (params.decay ?? 0.1);

    const osc = ctx.createOscillator();
    osc.type = params.type ?? "square";
    osc.frequency.setValueAtTime(params.freq, t0);
    if (params.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, params.freqEnd),
        t0 + dur
      );
    }
    if (params.detune) osc.detune.value = params.detune;

    const g = ctx.createGain();
    this.envelope(g, params.peak ?? 0.12, params.attack ?? 0.004, params.decay ?? 0.1, t0);

    let tail: AudioNode = g;
    if (params.filter) {
      const f = ctx.createBiquadFilter();
      f.type = params.filter.type;
      f.frequency.value = params.filter.freq;
      if (params.filter.Q !== undefined) f.Q.value = params.filter.Q;
      g.connect(f);
      tail = f;
    }
    osc.connect(g);
    tail.connect(this.master);
    if (params.reverbSend && this.reverb) {
      const send = ctx.createGain();
      send.gain.value = params.reverbSend;
      tail.connect(send);
      send.connect(this.reverb);
    }

    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private playNoise(params: {
    duration: number;
    peak?: number;
    filter?: { type: BiquadFilterType; freq: number; Q?: number };
    startAt?: number;
    reverbSend?: number;
  }): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = params.startAt ?? ctx.currentTime;
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * params.duration));
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const g = ctx.createGain();
    this.envelope(g, params.peak ?? 0.06, 0.002, params.duration, t0);

    let tail: AudioNode = g;
    if (params.filter) {
      const f = ctx.createBiquadFilter();
      f.type = params.filter.type;
      f.frequency.value = params.filter.freq;
      if (params.filter.Q !== undefined) f.Q.value = params.filter.Q;
      g.connect(f);
      tail = f;
    }
    src.connect(g);
    tail.connect(this.master);
    if (params.reverbSend && this.reverb) {
      const send = ctx.createGain();
      send.gain.value = params.reverbSend;
      tail.connect(send);
      send.connect(this.reverb);
    }

    src.start(t0);
    src.stop(t0 + params.duration + 0.02);
  }

  // Briefly attenuate the music bus so UI SFX read clearly over it.
  // `depth` is the floor (0..1) the bus drops to; `duration` is total time
  // before it returns to full. Safe to call repeatedly — schedules on top
  // of the running gain.
  private duckMusic(depth: number, duration: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    const target = 0.32; // must match startMusic's target bus gain
    try {
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(target, t);
      bus.gain.linearRampToValueAtTime(target * depth, t + 0.02);
      bus.gain.linearRampToValueAtTime(target, t + duration);
    } catch {}
  }

  // --- procedural music ---

  private startMusic(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    if (this.musicRunning) return;

    // Dedicated bus so the UI SFX always sit clearly on top.
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);
    this.musicBus = bus;

    // Fade-in over 6s, target level low enough that UI SFX sit on top
    // without competing. Overall music is background atmosphere, not
    // soundtrack.
    bus.gain.linearRampToValueAtTime(0.32, ctx.currentTime + 6);

    this.musicRunning = true;
    this.beatIndex = 0;
    this.nextScheduleAt = ctx.currentTime + 0.15;
    const tick = () => {
      if (!this.musicRunning) return;
      this.scheduleMusicAhead();
      this.schedulerTimer = window.setTimeout(tick, 60) as unknown as number;
    };
    tick();
  }

  private stopMusic(): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    this.musicRunning = false;
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (ctx && bus) {
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
      // Capture the bus in closure and only null `this.musicBus` if it's
      // still the same one. Otherwise a quick disable→enable cycle (e.g.
      // React strict-mode double-effects, or fast game→home navigation)
      // can delete a freshly-started bus a second after it was created.
      setTimeout(() => {
        try { bus.disconnect(); } catch {}
        if (this.musicBus === bus) this.musicBus = null;
      }, 1000);
    } else {
      this.musicBus = null;
    }
  }

  // Temporarily mute the music without tearing down the engine. Returns
  // an "un-duck" fn that restores the bus to its normal level. Use this
  // for transient navigational mutes (like opening a game) rather than
  // disable()/enable(), which dispose and recreate nodes and are race-y.
  softMuteMusic(): () => void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return () => {};
    const t0 = ctx.currentTime;
    bus.gain.cancelScheduledValues(t0);
    bus.gain.setValueAtTime(bus.gain.value, t0);
    bus.gain.linearRampToValueAtTime(0.0001, t0 + 0.4);
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      const b = this.musicBus;
      if (!ctx || !b) return;
      const t = ctx.currentTime;
      b.gain.cancelScheduledValues(t);
      b.gain.setValueAtTime(b.gain.value, t);
      b.gain.linearRampToValueAtTime(0.32, t + 1.2);
    };
  }

  // Advance the scheduler in 0.5s chunks. Each call lines up every beat
  // that fires within [now, now + LOOKAHEAD].
  private scheduleMusicAhead(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const LOOKAHEAD = 0.5; // seconds
    const horizon = ctx.currentTime + LOOKAHEAD;
    while (this.nextScheduleAt < horizon) {
      this.scheduleBeat(this.beatIndex, this.nextScheduleAt);
      this.beatIndex++;
      this.nextScheduleAt += STEP;
    }
  }

  // Scheduling unit: one eighth note. Bar = 8 steps. Each step may fire a
  // pad, a walking-bass note, a vibraphone arpeggio note, a brushed-snare
  // tick, and an occasional glockenspiel sparkle.
  private scheduleBeat(step: number, at: number): void {
    const barLen = 8;
    const bar = Math.floor(step / barLen);
    const inBar = step % barLen;
    const chord = CHORDS[bar % CHORDS.length];

    // Swing: delay every other eighth by ~16%.
    const swingT = inBar % 2 === 1 ? at + STEP * 0.16 : at;

    // Pad swells in on the 1 of every bar and sustains through it.
    if (inBar === 0) this.playPad(chord.pad, at);

    // Walking bass: one note per beat (= every 2 steps).
    if (inBar % 2 === 0) {
      const bi = inBar / 2; // 0..3
      this.playBass(chord.bassWalk[bi], at);
    }

    // Vibraphone arpeggio: syncopated phrase mapping steps → scale index.
    // Rests on 4 & 8 for breathing. Slight bar-based offset creates
    // phrase movement across the progression.
    const ARP_PHRASE: (number | null)[] = [0, 2, 4, null, 3, 5, 2, null];
    const arpIdx = ARP_PHRASE[inBar];
    if (arpIdx !== null) {
      const f = chord.scale[(arpIdx + bar) % chord.scale.length];
      this.playVibes(f, swingT);
    }

    // Brushed-snare-ish hiss on the 2 & 4 of every bar (backbeat).
    if (inBar === 2 || inBar === 6) this.playBrush(swingT);

    // Glockenspiel sparkle: one per 4-bar phrase, on the last 2 steps of
    // that phrase, picking upper chord tones.
    if (bar % 4 === 3 && (inBar === 5 || inBar === 7)) {
      const f = chord.scale[chord.scale.length - 1 - (inBar === 5 ? 2 : 0)];
      this.playSparkle(f * 2, swingT);
    }
  }

  private playPad(notes: number[], at: number): void {
    const ctx = this.ctx!;
    const bus = this.musicBus;
    if (!bus) return;
    const dur = BEAT * 4 + 0.4;
    // Tremolo on the pad via slow gain LFO for that rhodes/EP shimmer.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    lp.Q.value = 0.5;
    lp.connect(bus);

    const tremGain = ctx.createGain();
    tremGain.gain.setValueAtTime(0.0001, at);
    tremGain.gain.exponentialRampToValueAtTime(0.18, at + 0.55);
    tremGain.gain.setValueAtTime(0.18, at + dur - 0.7);
    tremGain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    tremGain.connect(lp);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4.6;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.04;
    lfo.connect(lfoAmt);
    lfoAmt.connect(tremGain.gain);
    lfo.start(at);
    lfo.stop(at + dur + 0.1);

    for (const f of notes) {
      for (const d of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        o.detune.value = d;
        o.connect(tremGain);
        o.start(at);
        o.stop(at + dur + 0.05);
      }
    }
    if (this.reverb) {
      const send = ctx.createGain();
      send.gain.value = 0.55;
      lp.connect(send);
      send.connect(this.reverb);
    }
  }

  private playBass(freq: number, at: number): void {
    const ctx = this.ctx!;
    const bus = this.musicBus;
    if (!bus) return;
    const dur = BEAT * 0.9;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    lp.Q.value = 1.1;
    lp.connect(bus);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.24, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(lp);
    // Sine + triangle octave-up for definition.
    const o1 = ctx.createOscillator();
    o1.type = "sine";
    o1.frequency.value = freq;
    o1.connect(g);
    const o2 = ctx.createOscillator();
    o2.type = "triangle";
    o2.frequency.value = freq * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.3;
    o2.connect(g2);
    g2.connect(g);
    o1.start(at); o2.start(at);
    o1.stop(at + dur + 0.05); o2.stop(at + dur + 0.05);
  }

  // Vibraphone voice: FM-ish (carrier sine + fast-decay modulator) with a
  // subtle vibrato on the carrier for that shimmering cocktail feel.
  private playVibes(freq: number, at: number): void {
    const ctx = this.ctx!;
    const bus = this.musicBus;
    if (!bus) return;
    const dur = STEP * 2.5;

    const carrier = ctx.createOscillator();
    carrier.type = "sine";
    carrier.frequency.value = freq;

    // Vibrato LFO → carrier detune
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.5;
    const vibAmt = ctx.createGain();
    vibAmt.gain.value = 8; // cents
    vib.connect(vibAmt);
    vibAmt.connect(carrier.detune);

    // Modulator for metallic overtone
    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.value = freq * 3;
    const modAmt = ctx.createGain();
    modAmt.gain.setValueAtTime(freq * 1.2, at);
    modAmt.gain.exponentialRampToValueAtTime(0.01, at + 0.25);
    mod.connect(modAmt);
    modAmt.connect(carrier.frequency);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.11, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    carrier.connect(g);
    g.connect(bus);

    carrier.start(at); mod.start(at); vib.start(at);
    carrier.stop(at + dur + 0.05);
    mod.stop(at + dur + 0.05);
    vib.stop(at + dur + 0.05);

    if (this.reverb) {
      const send = ctx.createGain();
      send.gain.value = 0.6;
      g.connect(send);
      send.connect(this.reverb);
    }
  }

  // Brushed-snare-ish swish for backbeat.
  private playBrush(at: number): void {
    const ctx = this.ctx!;
    const bus = this.musicBus;
    if (!bus) return;
    const dur = 0.12;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = 6500;
    filt.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(bus);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  // Glockenspiel-ish sparkle — bright, tiny.
  private playSparkle(freq: number, at: number): void {
    const ctx = this.ctx!;
    const bus = this.musicBus;
    if (!bus) return;
    const dur = 0.5;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.09, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g);
    g.connect(bus);
    o.start(at);
    o.stop(at + dur + 0.05);
    if (this.reverb) {
      const send = ctx.createGain();
      send.gain.value = 0.7;
      g.connect(send);
      send.connect(this.reverb);
    }
  }

  // --- the palette ---

  /** Primary action click: snap + bandpassed square with a small drop. */
  click(): void {
    if (!this.enabled) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.playNoise({ duration: 0.025, peak: 0.14, filter: { type: "highpass", freq: 1800, Q: 0.8 }, startAt: t });
    this.playOsc({
      freq: 880, freqEnd: 520, type: "square",
      attack: 0.003, decay: 0.1, peak: 0.18,
      filter: { type: "bandpass", freq: 1400, Q: 2.8 },
      reverbSend: 0.5, startAt: t,
    });
    this.duckMusic(0.4, 0.22);
  }

  /** Hover acknowledge — a short upward chirp + noise tick, plus a music
   *  duck so it's audible through the pad without being loud.
   *  Internally rate-limited to ~80 ms so moving across big elements
   *  doesn't machine-gun. */
  hover(): void {
    if (!this.enabled) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (now - this.lastHover < 0.08) return;
    this.lastHover = now;
    // Upward chirp — 1400 → 2200 Hz over 80 ms. Triangle for cleaner tone.
    this.playOsc({
      freq: 1400, freqEnd: 2200, type: "triangle",
      attack: 0.002, decay: 0.1, peak: 0.18,
      filter: { type: "bandpass", freq: 2400, Q: 1.6 },
      reverbSend: 0.3,
    });
    // Plus a short noise snap — gives it the "tick" of a real UI click.
    this.playNoise({
      duration: 0.02, peak: 0.09,
      filter: { type: "highpass", freq: 3000 },
    });
    // Duck the music for 180 ms so the SFX punches through.
    this.duckMusic(0.55, 0.18);
  }

  /** Ascending two-note "affirmative". */
  confirm(): void {
    if (!this.enabled) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.playOsc({
      freq: 660, freqEnd: 680, type: "square",
      attack: 0.003, decay: 0.11, peak: 0.08,
      filter: { type: "bandpass", freq: 1200, Q: 2.5 },
      reverbSend: 0.45, startAt: t,
    });
    this.playOsc({
      freq: 990, freqEnd: 1020, type: "square",
      attack: 0.003, decay: 0.14, peak: 0.08,
      filter: { type: "bandpass", freq: 1700, Q: 2.5 },
      reverbSend: 0.5, startAt: t + 0.07,
    });
  }

  /** Descending two-note deny. */
  deny(): void {
    if (!this.enabled) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.playOsc({
      freq: 520, freqEnd: 420, type: "sawtooth",
      attack: 0.003, decay: 0.12, peak: 0.075,
      filter: { type: "bandpass", freq: 900, Q: 3 },
      reverbSend: 0.35, startAt: t,
    });
    this.playOsc({
      freq: 380, freqEnd: 280, type: "sawtooth",
      attack: 0.003, decay: 0.18, peak: 0.08,
      filter: { type: "bandpass", freq: 700, Q: 3 },
      reverbSend: 0.45, startAt: t + 0.08,
    });
  }

  /** Incoming chat / notification ping — bell-like. */
  notify(): void {
    if (!this.enabled) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    // FM-ish bell: carrier sine + modulator sine via detune.
    this.playOsc({
      freq: 1320, type: "sine",
      attack: 0.002, decay: 0.55, peak: 0.08,
      filter: { type: "lowpass", freq: 3500 },
      reverbSend: 0.6, startAt: t,
    });
    this.playOsc({
      freq: 1980, type: "sine",
      attack: 0.002, decay: 0.35, peak: 0.05,
      filter: { type: "lowpass", freq: 3000 },
      reverbSend: 0.55, startAt: t,
      detune: 4,
    });
    this.playNoise({
      duration: 0.02, peak: 0.04,
      filter: { type: "highpass", freq: 4000 },
      startAt: t,
    });
  }

  /** Short filter sweep for state/route transitions. */
  transition(): void {
    if (!this.enabled) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.playOsc({
      freq: 220, freqEnd: 880, type: "triangle",
      attack: 0.01, decay: 0.32, peak: 0.055,
      filter: { type: "bandpass", freq: 1500, Q: 4 },
      reverbSend: 0.5, startAt: t,
    });
    this.playNoise({
      duration: 0.18, peak: 0.03,
      filter: { type: "bandpass", freq: 2200, Q: 3 },
      startAt: t,
    });
  }

  /** Startup chime: low→mid→high three-note acknowledge. */
  boot(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    const steps: { f: number; type: OscillatorType }[] = [
      { f: 220, type: "sawtooth" },
      { f: 330, type: "sawtooth" },
      { f: 660, type: "sine" },
    ];
    steps.forEach((s, i) => {
      this.playOsc({
        freq: s.f, type: s.type,
        attack: 0.005, decay: 0.35, peak: 0.09,
        filter: { type: "lowpass", freq: 2200 },
        reverbSend: 0.5, startAt: t + i * 0.13,
      });
    });
  }

  /** Achievement-unlocked fanfare — rising arpeggio (I-iii-V-octave in
   *  D) with a glittery high sparkle on top and a soft noise tail. Warmer
   *  than the boot chime and punchier than confirm(), so an unlock feels
   *  distinct from any other UI event. */
  achievement(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    // D major triad → octave D (587→740→880→1175 Hz).
    const arpeggio = [587.33, 739.99, 880.0, 1174.66];
    arpeggio.forEach((f, i) => {
      this.playOsc({
        freq: f, type: "triangle",
        attack: 0.004, decay: 0.28 + i * 0.04, peak: 0.085,
        filter: { type: "lowpass", freq: 3000 },
        reverbSend: 0.6, startAt: t + i * 0.08,
      });
      // A cleaner sine doubled an octave up gives the "shine".
      this.playOsc({
        freq: f * 2, type: "sine",
        attack: 0.003, decay: 0.2 + i * 0.03, peak: 0.04,
        filter: { type: "lowpass", freq: 5000 },
        reverbSend: 0.55, startAt: t + i * 0.08,
      });
    });
    // Glittery sparkle tail: two high bell tones detuned against each
    // other.
    this.playOsc({
      freq: 2637, type: "sine",
      attack: 0.002, decay: 0.6, peak: 0.055,
      filter: { type: "highpass", freq: 1500 },
      reverbSend: 0.7, startAt: t + arpeggio.length * 0.08,
    });
    this.playOsc({
      freq: 3520, type: "sine",
      attack: 0.002, decay: 0.5, peak: 0.04,
      filter: { type: "highpass", freq: 2000 },
      reverbSend: 0.7, startAt: t + arpeggio.length * 0.08 + 0.06,
    });
    // Tiny noise pop at the start for a "chime hit" transient.
    this.playNoise({
      duration: 0.06, peak: 0.035,
      filter: { type: "highpass", freq: 3500 },
      startAt: t,
    });
    // Light duck on the ambient music so the chime sits on top without
    // competing — matches the UI pattern used elsewhere.
    this.duckMusic(0.45, 0.9);
  }

  /** Per-keystroke micro-tick. Very quiet. */
  key(): void {
    if (!this.enabled) return;
    const freq = 1200 + Math.random() * 260;
    this.playOsc({
      freq, type: "square",
      attack: 0.001, decay: 0.025, peak: 0.012,
      filter: { type: "bandpass", freq: 2000, Q: 3 },
    });
  }
}

// Singleton. Guard against SSR — the constructor is cheap but we don't
// instantiate the AudioContext until enable() runs in the browser.
export const sound = new SoundEngine();

// Convenient ambient binding of delegated UI events. Attach once from
// SoundBoot after the AudioContext has been unlocked.
//
// Selectors are intentionally broad — anything that *looks* interactive
// (links, buttons, form controls, tabs, cards, anything flagged with
// [data-sfx] or cursor-pointer) gets hover/click acknowledgement.
const INTERACTIVE =
  'a, button, .btn, [role=button], [role=tab], [role=menuitem], [role=option], ' +
  'input:not([type=hidden]), select, textarea, label, summary, ' +
  '[data-sfx], [data-clickable], .link-term';

export function bindDelegatedUiSounds() {
  if (typeof window === "undefined") return () => {};

  // We use `pointerover` (unified mouse+touch+pen) rather than mouseover,
  // and we rely on the engine's internal rate-limit rather than trying to
  // dedupe by element ourselves — that dedup bug was swallowing hovers
  // when the cursor re-entered the same element after audio unlocked.
  const onOver = (e: PointerEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest) return;
    if (t.closest(INTERACTIVE)) sound.hover();
  };
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest) return;
    const el = t.closest(INTERACTIVE) as HTMLElement | null;
    if (!el) return;
    const sfx = el.getAttribute("data-sfx");
    if (sfx === "deny" || el.classList.contains("deny")) sound.deny();
    else if (sfx === "confirm" || el.classList.contains("confirm")) sound.confirm();
    else if (sfx === "notify") sound.notify();
    else sound.click();
  };
  const onFocus = (e: FocusEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.matches?.("input, select, textarea")) sound.hover();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Enter") sound.key();
  };

  window.addEventListener("pointerover", onOver, true);
  window.addEventListener("mousedown", onClick, true);
  window.addEventListener("focusin", onFocus, true);
  window.addEventListener("keydown", onKey, true);

  // Expose the engine globally in dev so users can verify from the
  // console: `__sound.hover()` / `__sound.isEnabled()`.
  try { (window as unknown as { __sound: unknown }).__sound = sound; } catch {}

  return () => {
    window.removeEventListener("pointerover", onOver, true);
    window.removeEventListener("mousedown", onClick, true);
    window.removeEventListener("focusin", onFocus, true);
    window.removeEventListener("keydown", onKey, true);
  };
}
