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

// --- procedural music composer ---
//
// Goal: a continuous, evolving, non-repeating score in D dorian that
// sounds like an actual hand-played lounge session, not a drone. We
// generate material at three time-scales:
//
//   1. Per bar — a Markov-walk chord function (i / ii / III / IV / v /
//      vi / VII), a randomly-chosen voicing out of 4 shapes, a bass
//      pattern out of 5 shapes, an arpeggio phrase out of 5 shapes.
//   2. Per 16-bar section — a "density" curve orchestrating which
//      voices are active (sparse intros with just pad+bass, denser
//      B sections with arpeggio + backbeat + occasional lead melody,
//      peak C sections adding sparkle sprays).
//   3. Per 4-bar phrase — a lead melody fragment improvised from the
//      current chord's scale, phrased around chord tones on downbeats
//      and passing tones off the beat.
//
// Nothing is a fixed loop. The Markov walker prefers tasteful
// resolutions (IV→VII→III, ii→v→i, VII→III turnarounds) but
// surprises the ear often enough that no 8-bar phrase ever feels
// identical to a past one.
//
// Swing eighths (~16% delay on offbeat), ~96 bpm. Scheduler is still
// the Web Audio clock; everything below is the material generator.

const BPM = 96;
const BEAT = 60 / BPM;
const STEP = BEAT / 2;

// D dorian scale root + semitone intervals.
// Scale degrees: 0=D, 1=E, 2=F, 3=G, 4=A, 5=B, 6=C (then repeats).
const DORIAN_BASE_HZ = 146.83; // D3
const DORIAN_STEPS = [0, 2, 3, 5, 7, 9, 10];

// Turn a signed scale-degree index (0 = D3, 7 = D4, -7 = D2, etc.)
// into a frequency. Used everywhere below so we never hand-type hertz.
function degHz(d: number): number {
  const mod = ((d % 7) + 7) % 7;
  const oct = Math.floor(d / 7);
  return DORIAN_BASE_HZ * Math.pow(2, (DORIAN_STEPS[mod] + oct * 12) / 12);
}

// Seven diatonic chord functions plus one borrowed bII for color.
// Each entry is: root scale-degree + the tones (as scale-degree offsets
// from the root) that can appear in a voicing. The voicing picker then
// chooses which tones to actually sound.
type ChordFn = {
  root: number;               // scale degree (0..6) of the root
  tones: number[];            // offsets from root (scale steps): 0=root, 2=3rd, 4=5th, 6=7th, 8=9th, 10=11th, 12=13th
  quality: "min" | "maj" | "dim" | "dom";
};
const FNS: Record<string, ChordFn> = {
  i:   { root: 0, tones: [0, 2, 4, 6, 8],     quality: "min" }, // Dm9
  ii:  { root: 1, tones: [0, 2, 4, 6, 8],     quality: "min" }, // Em11
  III: { root: 2, tones: [0, 2, 4, 6, 8],     quality: "maj" }, // Fmaj9
  IV:  { root: 3, tones: [0, 2, 4, 6, 8, 10], quality: "dom" }, // G13
  v:   { root: 4, tones: [0, 2, 4, 6, 8],     quality: "min" }, // Am11
  vi:  { root: 5, tones: [0, 2, 4, 6],        quality: "dim" }, // Bm7b5
  VII: { root: 6, tones: [0, 2, 4, 6, 8],     quality: "maj" }, // Cmaj9
};

// Markov transitions — weights hand-tuned so cycle-of-fourths motion
// and deceptive cadences both show up regularly, while consecutive
// duplicates stay rare. Each entry: [next function, weight].
const TRANSITIONS: Record<string, [string, number][]> = {
  i:   [["IV", 3.0], ["VII", 2.4], ["v", 1.8], ["ii", 1.5], ["III", 1.2], ["vi", 0.6], ["i", 0.4]],
  ii:  [["v", 3.0], ["IV", 2.0], ["VII", 1.8], ["i", 1.4], ["III", 1.0], ["ii", 0.3]],
  III: [["IV", 2.2], ["VII", 2.2], ["i", 1.8], ["ii", 1.0], ["vi", 0.8], ["III", 0.3]],
  IV:  [["VII", 2.8], ["III", 2.0], ["i", 1.8], ["ii", 1.4], ["v", 1.0], ["IV", 0.3]],
  v:   [["i", 3.0], ["IV", 1.6], ["VII", 1.4], ["ii", 1.2], ["III", 1.0], ["v", 0.3]],
  vi:  [["v", 2.4], ["VII", 2.0], ["ii", 1.4], ["i", 1.8], ["III", 0.6]],
  VII: [["III", 2.6], ["i", 2.4], ["IV", 1.8], ["vi", 1.0], ["ii", 1.0], ["VII", 0.3]],
};

function pickWeighted<T>(opts: [T, number][], rnd: () => number): T {
  let total = 0;
  for (const [, w] of opts) total += w;
  let r = rnd() * total;
  for (const [v, w] of opts) { r -= w; if (r <= 0) return v; }
  return opts[opts.length - 1][0];
}

// Instantiate a chord into concrete sounding material for one bar.
// `voicingId` picks which tones go into which octaves; the different
// voicings (close / spread / quartal / rootless) keep successive bars
// from sounding identical even if the Markov walker revisits a chord.
type BarMaterial = {
  fnName: string;
  root: number;                 // scale degree (0..6)
  padNotes: number[];           // frequencies
  scaleHz: number[];            // 8 scale tones in two-octave window
  scaleDeg: number[];           // matching scale-degree seeds for lead
  quality: ChordFn["quality"];
};

function voiceChord(fnName: string, voicingId: number): BarMaterial {
  const fn = FNS[fnName] || FNS.i;
  const root = fn.root;

  // Build the chord tones at absolute scale-degree positions.
  // tones[i] are degree offsets from root (0=root, 2=3rd, etc.)
  const absTones = fn.tones.map((t) => root + t);

  let pad: number[];
  switch (voicingId % 4) {
    case 0: // Close voicing from octave 0-1
      pad = absTones.slice(0, 5).map((d) => degHz(d));
      break;
    case 1: // Spread — root in octave -1, rest in 1
      pad = [
        degHz(absTones[0] - 7),
        ...absTones.slice(1, 5).map((d) => degHz(d + 7)),
      ];
      break;
    case 2: // Quartal — stack fourths from the root
      pad = [0, 3, 6, 9, 12].map((i) => degHz(absTones[0] + i));
      break;
    case 3: // Rootless — drop the root, emphasize 3 / 7 / 9 / 11 / 13
    default:
      pad = absTones.slice(1).map((d) => degHz(d + 7));
      break;
  }

  // Two-octave scale window anchored around the chord root, shifted
  // upward to keep the lead in a bright register.
  const scaleDeg: number[] = [];
  for (let i = 0; i < 8; i++) scaleDeg.push(root + 7 + i); // +7 = one octave up
  const scaleHz = scaleDeg.map((d) => degHz(d));

  return { fnName, root, padNotes: pad, scaleHz, scaleDeg, quality: fn.quality };
}

// Bass walks: 4 quarter-notes per bar. Returned as scale-degree
// indices so we can compute frequencies with chord context at
// schedule time.
type BassPattern = "desc7" | "asc7" | "pedal" | "chromatic" | "scalar";
const BASS_PATTERNS: [BassPattern, number][] = [
  ["desc7", 2], ["asc7", 1.6], ["pedal", 1], ["chromatic", 1.4], ["scalar", 1.5],
];
function bassWalk(root: number, pat: BassPattern, nextRoot: number): number[] {
  const r = root - 14; // 2 octaves below the lead window
  switch (pat) {
    case "desc7":     return [r, r + 6, r + 4, r + 2];
    case "asc7":      return [r, r + 2, r + 4, r + 6];
    case "pedal":     return [r, r + 4, r, r + 4];
    case "scalar":    return [r, r + 1, r + 2, r + 3];
    case "chromatic": {
      // End with a chromatic approach into the next chord's root.
      const approach = (nextRoot - 14) - 1; // one semitone below (approximate via scalar-1)
      return [r, r + 4, r + 2, approach];
    }
  }
}

// Arpeggio phrases — 8-step patterns, indices into the scale window.
// `null` = rest (breathing space).
type ArpPhrase = (number | null)[];
const ARP_PHRASES: [ArpPhrase, number][] = [
  [[0, 2, 4, null, 3, 5, 2, null], 2.0],
  [[0, 4, 2, null, 5, 3, 7, null], 1.6],
  [[0, 2, null, 4, null, 3, 5, null], 1.2],
  [[null, 2, 4, 0, null, 3, 5, 2], 1.4],
  [[0, 2, 4, 2, null, 3, null, 5], 1.0],
  [[0, null, 4, null, 3, null, 5, null], 0.8],
];

// Generate a sparse improvised 4-bar melody over the chord. Returns a
// list of (step-in-4-bar-phrase, scale-degree-above-root, duration) —
// the scheduler places each against real ctx time when the right step
// lands. Notes land on strong beats biased toward chord tones; off-beat
// notes weight toward passing tones (odd scale degrees).
//
// Density shapes how many notes appear (3..6) and how adventurous the
// intervals get. Phrase length is 32 steps (4 bars × 8 eighths).
function generateLeadPhrase(
  mat: BarMaterial,
  density: number,
  rnd: () => number
): Array<{ at: number; deg: number; dur: number }> {
  const notes: Array<{ at: number; deg: number; dur: number }> = [];
  // Chord tones (deg offsets from the bar's root, one octave above).
  const chordDegs = [0, 2, 4, 6];
  const passing = [1, 3, 5];
  const count = 3 + Math.floor(rnd() * (density > 0.8 ? 4 : 3)); // 3..5 (or 6 at peak)

  // Reserve spots: one on bar 1 beat 1, one on bar 3 beat 1, rest scattered.
  const reserved = [0, 16];
  const scattered: number[] = [];
  while (scattered.length < count - reserved.length) {
    const step = Math.floor(rnd() * 32);
    if (scattered.includes(step) || reserved.includes(step)) continue;
    scattered.push(step);
  }
  const slots = [...reserved, ...scattered].sort((a, b) => a - b);

  for (const at of slots) {
    const onStrong = at % 4 === 0;
    const pool = onStrong ? chordDegs : (rnd() < 0.65 ? chordDegs : passing);
    let deg = pool[Math.floor(rnd() * pool.length)];
    // Occasional octave jump or chromatic neighbor for color.
    if (rnd() < 0.12) deg += 7;
    if (rnd() < 0.08) deg -= 1;
    // Duration: mostly eighths, sometimes dotted-eighths, rare
    // quarter-and-a-half for held phrase endings.
    const durRoll = rnd();
    const durSteps = durRoll < 0.65 ? 1 : durRoll < 0.9 ? 1.5 : 3;
    notes.push({ at, deg, dur: durSteps });
  }
  return notes;
}

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

  // Refcounted music suppression. softMuteMusic() (called from the game
  // page) bumps this; its returned release fn decrements. Any count > 0
  // keeps the music bus silent even if the engine is (re)enabled or a
  // new bus is created while suppressed. This fixes the "navigate to a
  // game, then click inside the iframe, then the music starts playing
  // over the game" bug where startMusic() ran after softMuteMusic() had
  // returned a no-op cleanup because musicBus was still null at mount.
  private musicSuppressed = 0;
  private readonly MUSIC_TARGET = 0.32;

  // Defensive: some browsers (Safari on iOS, Chrome when a tab goes to
  // background for long) transition the AudioContext back to "suspended"
  // after it was already running. Every sfx method calls resumeIfNeeded()
  // so a resume is attempted on the very next user-driven sound —
  // otherwise the engine looks `enabled: true` but silently produces no
  // audio until the user toggles mute.
  private resumeIfNeeded(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => { /* next gesture will try again */ });
    }
  }

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

  async enable(options?: { silent?: boolean }): Promise<void> {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* browsers can throw if no
        gesture has happened yet — we silently retry on the next
        engage path, see SoundBoot.tsx */ }
    }
    // Only consider the engine truly enabled if the context is actually
    // running. Eager mount calls (no gesture yet) typically leave ctx
    // in "suspended" despite a resolved resume() promise; treating that
    // as "enabled" would otherwise schedule audio events that never
    // make sound.
    if (ctx.state !== "running") return;
    if (!this.enabled) {
      this.enabled = true;
      // `silent: true` is used by the eager auto-mount path so users
      // don't get a startup chime every time they navigate within the
      // SPA. The mute-button "unmute" flow still fires the chime, since
      // that IS an explicit "turn audio on" action worth acknowledging.
      if (!options?.silent) this.boot();
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
    // Respect the music-suppression refcount. When the player is on a
    // game page, softMuteMusic() bumps `musicSuppressed` and rams the
    // bus down to silent. Ducking here would cancel those scheduled
    // values and set gain back to MUSIC_TARGET — effectively unmuting
    // the music every time a UI hover fired. Skip the duck entirely
    // while suppression is active; the music is supposed to be silent,
    // so there's nothing to duck.
    if (this.musicSuppressed > 0) return;
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    const target = this.MUSIC_TARGET;
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

    // Fade-in over 2s — audible quickly after unlock, but still a
    // deliberate ramp so music doesn't punch in at full volume like a
    // pop-up alert. Suppressed? Keep silent; the release fn returned
    // by softMuteMusic will ramp it up when the user navigates away.
    if (this.musicSuppressed === 0) {
      bus.gain.linearRampToValueAtTime(this.MUSIC_TARGET, ctx.currentTime + 2);
    }

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

  // Suppress music without tearing down the engine. Refcounted — multiple
  // overlapping mutes (e.g. StrictMode double-effects, or two navigation
  // guards) compose correctly. The returned release fn only restores
  // music when the last suppressor lets go. Survives across startMusic()
  // calls: if music hasn't started yet (engine not enabled), the flag is
  // still honored when start eventually happens.
  softMuteMusic(): () => void {
    this.musicSuppressed++;
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (ctx && bus) {
      const t0 = ctx.currentTime;
      bus.gain.cancelScheduledValues(t0);
      bus.gain.setValueAtTime(bus.gain.value, t0);
      bus.gain.linearRampToValueAtTime(0.0001, t0 + 0.4);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.musicSuppressed = Math.max(0, this.musicSuppressed - 1);
      if (this.musicSuppressed > 0) return;
      const c = this.ctx;
      const b = this.musicBus;
      if (!c || !b) return;
      const t = c.currentTime;
      b.gain.cancelScheduledValues(t);
      b.gain.setValueAtTime(b.gain.value, t);
      b.gain.linearRampToValueAtTime(this.MUSIC_TARGET, t + 1.2);
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

  // --- composer state ---
  // Reset when the engine starts fresh; persists across bars so each
  // new bar is "next" in a sequence rather than a cold draw.
  private composer = {
    fnName: "i" as string,
    lastFn: "" as string,
    material: null as BarMaterial | null,
    nextMaterial: null as BarMaterial | null,
    bassPattern: "desc7" as BassPattern,
    arpPhrase: ARP_PHRASES[0][0] as ArpPhrase,
    sectionBar: 0,                      // 0..15 position in current section
    section: 0,                         // section counter
    density: 0.5,                       // 0..1, what's playing
    leadPhrase: [] as Array<{ at: number; deg: number; dur: number }>, // relative timings within a 4-bar phrase
    leadBar: 0,                         // 0..3 within the current 4-bar phrase
  };

  // Called on bar boundary (inBar === 0). Advances section state,
  // picks the next chord, regenerates voicings + patterns + (on 4-bar
  // marks) a lead phrase. All randomness is pulled from Math.random
  // so each session draws a unique score.
  private planNextBar(): void {
    const c = this.composer;

    // Section-level density curve. 16 bars per section, density
    // follows a smooth cosine window so the listener gets recognizable
    // rise/fall shapes without a hard on/off feel. The absolute floor
    // and ceiling drift slowly so no two sections sound identical.
    const sectionProg = c.sectionBar / 16;
    const sectionFloor = 0.2 + 0.15 * Math.sin(c.section * 0.7);
    const sectionCeil  = 0.85 + 0.1  * Math.sin(c.section * 0.53 + 1.2);
    const curve = 0.5 - 0.5 * Math.cos(sectionProg * Math.PI * 2);
    c.density = sectionFloor + (sectionCeil - sectionFloor) * curve;

    // Pick next chord via Markov walk. Avoid the exact same 2-chord
    // alternation (X→Y→X→Y) by re-rolling once if that pattern appears.
    let candidate = pickWeighted(TRANSITIONS[c.fnName] || [["i", 1]], Math.random);
    if (candidate === c.lastFn && Math.random() < 0.6) {
      candidate = pickWeighted(TRANSITIONS[c.fnName] || [["i", 1]], Math.random);
    }
    c.lastFn = c.fnName;
    c.fnName = candidate;

    // New voicing each bar so revisits don't sound copied.
    const voicingId = Math.floor(Math.random() * 4);
    c.material = voiceChord(c.fnName, voicingId);

    // Peek ahead for chromatic bass approach.
    const peekNext = pickWeighted(TRANSITIONS[c.fnName] || [["i", 1]], Math.random);
    c.nextMaterial = voiceChord(peekNext, Math.floor(Math.random() * 4));

    // Bass + arp patterns. Slight bias toward repeating the arpeggio
    // across 2-bar pairs (musical phrasing) but always freshly drawn
    // on bar 1 of each 4-bar phrase.
    c.bassPattern = pickWeighted(BASS_PATTERNS, Math.random);
    if (c.sectionBar % 4 === 0) {
      c.arpPhrase = pickWeighted(ARP_PHRASES, Math.random);
    }

    // On each 4-bar phrase boundary (if density high enough) draft
    // a lead melody — a tiny improvised line that sits over the next
    // 4 bars. Store as (offset-in-steps, scale-degree, duration)
    // tuples so the scheduler can place them against real ctx time.
    if (c.sectionBar % 4 === 0 && c.density > 0.55) {
      c.leadPhrase = generateLeadPhrase(c.material, c.density, Math.random);
      c.leadBar = 0;
    }
    if (c.sectionBar % 4 !== 0) c.leadBar++;

    // Advance section counter.
    c.sectionBar = (c.sectionBar + 1) % 16;
    if (c.sectionBar === 0) c.section++;
  }

  // Eighth-note scheduler. Plans a new bar on every bar boundary,
  // then dispatches per-voice material to the sound engine.
  private scheduleBeat(step: number, at: number): void {
    const barLen = 8;
    const inBar = step % barLen;
    const c = this.composer;

    if (inBar === 0) this.planNextBar();
    const mat = c.material;
    if (!mat) return;

    // Swing: offbeats delayed ~16% of a step.
    const swingT = inBar % 2 === 1 ? at + STEP * 0.16 : at;

    // --- pad ---
    // Swells on every bar 1. Voicing was freshly picked in planNextBar.
    if (inBar === 0) this.playPad(mat.padNotes, at);

    // --- walking bass ---
    // 4 quarter notes per bar (= every 2 steps).
    if (inBar % 2 === 0) {
      const notes = bassWalk(
        mat.root,
        c.bassPattern,
        c.nextMaterial ? c.nextMaterial.root : mat.root
      );
      const bi = inBar / 2;
      this.playBass(degHz(notes[bi]), at);
    }

    // --- vibraphone arpeggio ---
    // Only plays if section density is past the threshold — sparse
    // intros breathe without arpeggiation, peak sections fill in.
    if (c.density > 0.35) {
      const arpIdx = c.arpPhrase[inBar];
      if (arpIdx !== null && arpIdx !== undefined) {
        // Occasionally transpose the phrase up an octave for a "lift".
        const shift = c.density > 0.7 && Math.random() < 0.18 ? 1 : 0;
        const hz = mat.scaleHz[arpIdx] * (shift ? 2 : 1);
        this.playVibes(hz, swingT);
      }
    }

    // --- brushed backbeat ---
    // Tick on 2 & 4 when density warrants. Skip on ultra-sparse intros.
    if (c.density > 0.45 && (inBar === 2 || inBar === 6)) {
      this.playBrush(swingT);
    }

    // --- glockenspiel sparkle ---
    // Last 2 steps of a 4-bar phrase if density is high, stochastic
    // drop-outs so it doesn't become clockwork.
    if (c.density > 0.6 && c.sectionBar % 4 === 3 && inBar >= 5 && Math.random() < 0.55) {
      const pick = mat.scaleHz[Math.min(mat.scaleHz.length - 1, 5 + (inBar % 3))];
      this.playSparkle(pick * 2, swingT);
    }

    // --- lead melody ---
    // A sparse line sitting above the arpeggio. Triggered from the
    // leadPhrase we drafted at the 4-bar mark. We match by step
    // within the 4-bar window so it locks to the bar structure.
    if (c.density > 0.7 && c.leadPhrase.length > 0) {
      const stepIn4Bar = c.leadBar * barLen + inBar;
      for (const note of c.leadPhrase) {
        if (note.at === stepIn4Bar) {
          const hz = degHz(mat.root + 7 + note.deg);
          this.playLead(hz, swingT, note.dur);
        }
      }
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

  // Lead voice — warm, slightly reedy. Filtered sawtooth with a slow
  // attack so notes bloom rather than stab, plus a light vibrato that
  // ramps in over the first 40% of the note (like a singer leaning
  // into a held tone). `durSteps` is in eighth-note steps; we convert
  // to seconds via STEP.
  private playLead(freq: number, at: number, durSteps: number): void {
    const ctx = this.ctx!;
    const bus = this.musicBus;
    if (!bus) return;
    const dur = Math.max(0.18, durSteps * STEP);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1600;
    lp.Q.value = 1.2;
    lp.connect(bus);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.055, at + 0.05);        // slow bloom
    g.gain.setValueAtTime(0.055, at + dur - 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(lp);

    // Sawtooth body + sine sub an octave down for warmth.
    const o1 = ctx.createOscillator();
    o1.type = "sawtooth";
    o1.frequency.value = freq;

    const o2 = ctx.createOscillator();
    o2.type = "sine";
    o2.frequency.value = freq * 0.5;
    const o2g = ctx.createGain();
    o2g.gain.value = 0.35;
    o2.connect(o2g);
    o2g.connect(g);

    // Delayed vibrato → mimics a player leaning on a sustained note.
    const vib = ctx.createOscillator();
    vib.frequency.value = 4.8;
    const vibAmt = ctx.createGain();
    vibAmt.gain.setValueAtTime(0, at);
    vibAmt.gain.linearRampToValueAtTime(6, at + dur * 0.4); // cents
    vib.connect(vibAmt);
    vibAmt.connect(o1.detune);

    // Filter sweep opens as the note blooms, closes as it fades.
    lp.frequency.setValueAtTime(1100, at);
    lp.frequency.linearRampToValueAtTime(2400, at + dur * 0.35);
    lp.frequency.linearRampToValueAtTime(1300, at + dur);

    o1.connect(g);
    o1.start(at); o2.start(at); vib.start(at);
    o1.stop(at + dur + 0.05);
    o2.stop(at + dur + 0.05);
    vib.stop(at + dur + 0.05);

    if (this.reverb) {
      const send = ctx.createGain();
      send.gain.value = 0.55;
      g.connect(send);
      send.connect(this.reverb);
    }
  }

  // --- the palette ---

  /** Primary action click: snap + bandpassed square with a small drop. */
  click(): void {
    this.resumeIfNeeded();
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
    this.resumeIfNeeded();
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
    this.resumeIfNeeded();
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
    this.resumeIfNeeded();
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

  /** Incoming chat / notification ping — bell-like. Generic (no handle). */
  notify(): void {
    this.notifyAs(null);
  }

  /** Per-user notify: deterministic pitch derived from the user's handle
   *  so each operator has a recognizable chime. Stays in D dorian so it
   *  always lands musically against the ambient soundtrack instead of
   *  clashing with it.
   *
   *  Passing null (or an empty string) reproduces the original neutral
   *  ping — useful for system notifications that aren't attributable to
   *  a specific user (e.g. "you've been mentioned"). */
  notifyAs(handle: string | null | undefined): void {
    this.resumeIfNeeded();
    if (!this.enabled) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    // D dorian scale in the 4th/5th octave — bright but inside the
    // key of the ambient music. 7 scale-degrees per octave, 2 octaves.
    const SCALE = [
      // Octave 5
      587.33, 659.25, 698.46, 783.99, 880.0, 987.77, 1046.5,
      // Octave 6
      1174.66, 1318.51, 1396.91, 1567.98, 1760.0, 1975.53, 2093.0,
    ];

    let root = 1046.5; // C6 default
    if (handle && handle.length > 0) {
      // FNV-1a 32-bit hash of the handle for deterministic mapping.
      let h = 2166136261;
      for (let i = 0; i < handle.length; i++) {
        h = Math.imul(h ^ handle.charCodeAt(i), 16777619);
      }
      root = SCALE[Math.abs(h) % SCALE.length];
    }
    const fifth = root * 1.5;

    this.playOsc({
      freq: root, type: "sine",
      attack: 0.002, decay: 0.55, peak: 0.08,
      filter: { type: "lowpass", freq: 3500 },
      reverbSend: 0.6, startAt: t,
    });
    this.playOsc({
      freq: fifth, type: "sine",
      attack: 0.002, decay: 0.35, peak: 0.05,
      filter: { type: "lowpass", freq: 3200 },
      reverbSend: 0.55, startAt: t + 0.015,
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
    this.resumeIfNeeded();
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
    this.resumeIfNeeded();
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
