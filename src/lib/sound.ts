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

// --- procedural EDM composer ---
//
// Goal: a continuous, non-repeating, melodic-EDM / hardware-synth score
// that reads as actual music — driving, hook-forward, with clear
// rise/fall dynamics — rather than ambient drone. Design:
//
//   1. Fixed 4-chord progressions (chosen per 16-bar section from a
//      pool) give the ear a phrase to hold on to. Progressions are
//      diatonic in D dorian so the site's whole audio system (chat
//      chimes, achievement fanfares, unlock SFX) stays in-key.
//
//   2. A per-section melodic **motif** — 8 scale-degree notes — is
//      drawn once and then developed: bar 1 plays it straight, bar 2
//      same, bar 3 transposed up a third, bar 4 ornamented with
//      passing tones. This gives music memorable hooks that repeat
//      with variation instead of a random walk every bar.
//
//   3. A 4-section super-cycle (intro → build → drop → breakdown)
//      orchestrates which voices play, with intensity mapped to a
//      cosine density curve inside each section. The drop is the
//      payoff — full drums + arp + lead + pumped pad.
//
//   4. Sidechain pump: the melodic bus ducks ~40% on every kick and
//      springs back over the beat, which is the canonical EDM "pump"
//      feel. No actual compressor math — just a gain envelope keyed
//      to kick hits.
//
// Voices are hardware-synth-flavored: supersaw pad (7 detuned sawtooth
// voices summed with chorus), resonant-filter saw lead, saw+square
// arp with lowpass cutoff sweep, sine-drop kick, filtered-noise hat
// and snare, sub-bass sine. All synthesized live in Web Audio.
//
// Straight 16ths at 120 BPM. No swing — EDM is rhythmically rigid on
// purpose. Scheduler is still the Web Audio clock; everything below
// is the material generator.

const BPM = 120;
const BEAT = 60 / BPM;               // quarter note
const STEP = BEAT / 4;               // 16th note — base scheduling unit
const BAR_STEPS = 16;                // 16 × 16th = 1 bar in 4/4

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

// 4-chord progression pool — each entry is 4 scale-degree indices,
// one per bar of a 4-bar phrase. All diatonic in D dorian (0=D, 1=E,
// 2=F, 3=G, 4=A, 5=B, 6=C). Drawn per 16-bar section so the ear gets
// a phrase to hold onto; repeats 4x inside the section. These are the
// kind of loops that feel EDM-classic: i-v-bVI-bVII style, some
// uplifting i-III-IV-v, and a sadder i-VI-v-VII for breakdowns.
const PROGRESSIONS: number[][] = [
  [0, 6, 2, 3],  // Dm → Cmaj → Fmaj → Gmaj   (classic rising, IV lift)
  [0, 4, 2, 6],  // Dm → Am   → Fmaj → Cmaj   (intro-feeling, resolved)
  [0, 3, 5, 6],  // Dm → Gmaj → Bm7b5 → Cmaj (modal, tension-release)
  [0, 2, 4, 6],  // Dm → Fmaj → Am → Cmaj    (all-thirds, hooky)
  [0, 6, 4, 3],  // Dm → Cmaj → Am → Gmaj    (descending bassline)
  [0, 3, 6, 4],  // Dm → Gmaj → Cmaj → Am    (driving, club-ready)
];

function pickInt(n: number, rnd: () => number): number {
  return Math.floor(rnd() * n);
}

// Melodic motifs — 8 scale-degree offsets, one per 8th note across a
// single bar. `null` = rest (breathing space). The motif is chosen
// per 16-bar section; across its four appearances inside the section
// we (1) play it straight, (2) play it again, (3) transpose up a
// third, (4) ornament with neighbor tones — giving the motif a little
// development arc rather than flat repetition.
type Motif = (number | null)[];
const MOTIFS: Motif[] = [
  [0, 2, 4, 2, null, 4, 2, 0],       // anchored arc
  [0, null, 4, 2, 0, 4, null, 2],    // syncopated
  [0, 4, 2, null, 4, 2, null, 0],    // call-response
  [0, 2, 4, 7, 4, 2, 0, null],       // octave reach + descent
  [2, 4, 2, 0, null, 0, 2, 4],       // upswing
  [4, 2, 0, null, 0, 2, 4, 2],       // descending then pivot
  [0, 2, null, 4, null, 2, 4, 0],    // sparse / airy
  [0, 4, 2, 0, 4, 2, 0, null],       // insistent, trance-y
];

// Section type drives orchestration:
//   intro     — pad + sub only; motif whispered once per chord
//   build     — add hat + kick (half-time) + motif more present
//   drop      — full: kick (4-on-the-floor) + snare + hat + arp + lead
//   breakdown — strip back: pad + lead + sparse hat
// A super-cycle is 4 sections = 64 bars, then repeats with a fresh
// progression + motif.
type SectionKind = "intro" | "build" | "drop" | "breakdown";
const SECTION_CYCLE: SectionKind[] = ["intro", "build", "drop", "breakdown"];

// Chord → voicing helpers. `rootDeg` is the scale-degree index (0..6)
// of the chord root within D dorian. Chord tones (triad + 7th + 9th)
// are derived by stacking thirds from the scale.
function chordRootHz(rootDeg: number): number {
  return degHz(rootDeg);
}
function chordTonesHz(rootDeg: number, opts: { seventh?: boolean; ninth?: boolean }): number[] {
  const triad = [rootDeg, rootDeg + 2, rootDeg + 4];
  if (opts.seventh) triad.push(rootDeg + 6);
  if (opts.ninth)   triad.push(rootDeg + 8);
  return triad.map(degHz);
}

// Returns a per-bar ornamented motif. Bar 0 = straight motif. Bar 1 =
// same. Bar 2 = transposed up a third (scale step +2). Bar 3 =
// original with a passing tone inserted on one of the null steps.
function motifForBar(base: Motif, bar: number, rnd: () => number): Motif {
  if (bar % 4 === 0 || bar % 4 === 1) return base;
  if (bar % 4 === 2) return base.map((n) => n === null ? null : n + 2);
  // bar === 3: ornament — replace a random rest with a passing tone.
  const out: Motif = base.slice();
  const rests: number[] = [];
  for (let i = 0; i < out.length; i++) if (out[i] === null) rests.push(i);
  if (rests.length > 0) {
    const pick = rests[Math.floor(rnd() * rests.length)];
    // Choose a passing tone close to the surrounding melody.
    const neighbor = (out[(pick + out.length - 1) % out.length] ?? 0) + (rnd() < 0.5 ? 1 : -1);
    out[pick] = neighbor;
  }
  return out;
}

class SoundEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private musicBus: GainNode | null = null;
  // UI SFX route through their own bus at unity gain so they sit
  // clearly over the ambient soundtrack (which rides on a separate
  // bus attenuated to ~0.32). Previously UI sounds connected straight
  // to master, which made them quieter than the music they were
  // supposed to punch through.
  private sfxBus: GainNode | null = null;
  // Music sub-buses. Drums route through drumBus straight to the
  // music bus. Melodic voices (pad / arp / sub / lead) route through
  // melodicBus, which gets sidechain-pumped on every kick hit.
  private drumBus: GainNode | null = null;
  private melodicBus: GainNode | null = null;
  private musicRunning = false;
  private nextScheduleAt = 0; // next beat time (absolute, ctx.currentTime scale)
  private beatIndex = 0;
  private schedulerTimer: number | null = null;
  private enabled = false;
  private lastHover = 0;
  private lastHoverVariant = -1;
  private lastClickVariant = -1;

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

    // Dedicated UI SFX bus at unity gain. Interface sounds need to sit
    // clearly over the music; the music bus rides at ~0.32, so UI at
    // master-only gain ~0.55 would be subjectively quieter. Parking UI
    // on its own bus keeps the signal path simple and loud.
    const sfxBus = ctx.createGain();
    sfxBus.gain.value = 1.0;
    sfxBus.connect(master);
    this.sfxBus = sfxBus;

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
    // UI SFX route through the dedicated sfxBus so they cut clearly
    // over the music bus. Music-specific voices (playPad/playBass/
    // playVibes/playLead/playSparkle/playBrush) use this.musicBus
    // directly and aren't affected by this routing change.
    const out = this.sfxBus ?? this.master;
    if (!ctx || !out) return;
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
    tail.connect(out);
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
    const out = this.sfxBus ?? this.master;
    if (!ctx || !out) return;
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
    tail.connect(out);
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

    // Sub-buses: drums bypass sidechain; melodic voices go through
    // melodicBus which gets ducked on every kick (the EDM pump).
    const drumBus = ctx.createGain();
    drumBus.gain.value = 1.0;
    drumBus.connect(bus);
    this.drumBus = drumBus;

    const melodicBus = ctx.createGain();
    melodicBus.gain.value = 1.0;
    melodicBus.connect(bus);
    this.melodicBus = melodicBus;

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
  // Resets when the engine starts. Persists across bars so material
  // drawn per-section survives the per-step dispatch inside the bar.
  private composer = {
    progression: PROGRESSIONS[0],
    motif: MOTIFS[0] as Motif,
    sectionKind: "intro" as SectionKind,
    sectionIdx: 0,                      // 0..3 within the super-cycle
    sectionBar: 0,                      // 0..15 within the section
    bar: 0,                             // running bar counter (session total)
    // Pending material for the current bar, filled on bar boundary
    // and dispatched over the next 16 steps.
    rootDeg: 0,
    barMotif: [] as Motif,
  };

  // Called on bar boundary. Advances the super-cycle, picks the
  // chord/motif/progression per section, then fixes the per-bar motif
  // (with development across the 4-bar phrase).
  private planNextBar(): void {
    const c = this.composer;

    // On each 16-bar section boundary, advance the cycle and redraw
    // material. Every fourth section (end of super-cycle) we reseed
    // the progression and motif so the score keeps generating new
    // phrases rather than looping.
    if (c.sectionBar === 0) {
      c.sectionKind = SECTION_CYCLE[c.sectionIdx % 4];
      if (c.sectionIdx % 4 === 0) {
        // Super-cycle start: fresh progression + motif.
        c.progression = PROGRESSIONS[pickInt(PROGRESSIONS.length, Math.random)];
        c.motif       = MOTIFS[pickInt(MOTIFS.length, Math.random)];
      }
    }

    // Each chord holds for 4 bars within the section. Four chords = 16
    // bars. Index into the progression by (sectionBar / 4).
    const chordIdx = Math.floor(c.sectionBar / 4) % 4;
    c.rootDeg = c.progression[chordIdx];

    // Develop the motif across the 4-bar chord span (bars 0,1,2,3).
    const barWithinChord = c.sectionBar % 4;
    c.barMotif = motifForBar(c.motif, barWithinChord, Math.random);

    // Advance counters.
    c.bar++;
    c.sectionBar = (c.sectionBar + 1) % 16;
    if (c.sectionBar === 0) c.sectionIdx = (c.sectionIdx + 1) % 4;
  }

  // 16th-note scheduler. Dispatches per-voice material to the sound
  // engine. `step` is the absolute 16th-note index from musicRunning.
  private scheduleBeat(step: number, at: number): void {
    const inBar = step % BAR_STEPS;
    const c = this.composer;

    if (inBar === 0) this.planNextBar();
    const root = c.rootDeg;
    const kind = c.sectionKind;

    // -------- drums --------
    // Kick policy by section:
    //   intro     — kick on bar 1 only (foreshadow)
    //   build     — kick on beats 1 and 3 (half-time)
    //   drop      — 4-on-the-floor (beats 1,2,3,4)
    //   breakdown — kick on beats 1 and 3; accent on last bar
    const onQuarter = inBar % 4 === 0;            // beats 1,2,3,4
    const onBeat13  = inBar === 0 || inBar === 8; // beats 1 and 3
    let kick = false;
    if (kind === "intro")     kick = c.sectionBar % 4 === 0 && inBar === 0;
    if (kind === "build")     kick = onBeat13;
    if (kind === "drop")      kick = onQuarter;
    if (kind === "breakdown") kick = onBeat13 || (c.sectionBar === 15 && inBar === 12);
    if (kick) this.playKick(at);

    // Snare/clap on beats 2 and 4 whenever drums are in. Light intro
    // variant: drop the snare entirely.
    const onBeat24 = inBar === 4 || inBar === 12;
    if (onBeat24 && (kind === "build" || kind === "drop")) this.playSnare(at);

    // Closed hats on every offbeat once we're past intro. 8th-note
    // offbeats = steps 2,6,10,14 (the "and" of each beat). During the
    // drop, double up to 16th-note hats for drive.
    const on8thOffbeat  = inBar % 4 === 2;
    const on16thHat     = inBar % 2 === 0; // every other 16th
    if (kind === "build"     && on8thOffbeat) this.playHat(at, 0.045);
    if (kind === "breakdown" && on8thOffbeat) this.playHat(at, 0.035);
    if (kind === "drop"      && on16thHat)    this.playHat(at, 0.04);

    // Sidechain pump: duck the melodic bus on every kick. Even in
    // breakdown/intro with sparse kicks, this keeps the characteristic
    // EDM pump feel locked to the beat.
    if (kick) this.pumpMelodicBus(at);

    // -------- sub bass --------
    // Held root note for the full bar with a slight re-trigger on
    // beat 3 for movement. Breakdowns use a longer sustained note.
    if (inBar === 0) this.playSub(chordRootHz(root - 7), at, kind === "breakdown" ? BEAT * 4 : BEAT * 2);
    if (inBar === 8 && kind !== "breakdown") this.playSub(chordRootHz(root - 7), at, BEAT * 2);

    // -------- pad --------
    // Sustained chord, swells in on every 4-bar chord boundary.
    if (c.sectionBar % 4 === 0 && inBar === 0) {
      const pad = chordTonesHz(root, { seventh: true, ninth: kind !== "intro" });
      this.playPad(pad, at);
    }

    // -------- arpeggio --------
    // Only during build and drop. Fast 16th-note saw arp through the
    // chord tones with a filter sweep baked per-note.
    if (kind === "build" || kind === "drop") {
      const density = kind === "drop" ? 1.0 : 0.5;
      // Build plays arp on every 2nd 16th; drop plays every 16th.
      const shouldPlay = (kind === "drop") || (inBar % 2 === 0);
      if (shouldPlay && Math.random() < 0.5 + 0.5 * density) {
        const chordDegs = [0, 2, 4, 6, 8];
        const deg = chordDegs[inBar % chordDegs.length];
        this.playArpNote(degHz(root + 7 + deg), at, STEP * 1.1);
      }
    }

    // -------- lead melody --------
    // Plays the motif on 8th-note subdivisions (every other 16th
    // step). Sections decide whether to play and how loud.
    if (inBar % 2 === 0) {
      const motifSlot = inBar / 2; // 0..7
      const motifNote = c.barMotif[motifSlot];
      if (motifNote !== null && motifNote !== undefined) {
        const leadOn = kind === "drop" || kind === "breakdown" || (kind === "build" && c.sectionBar >= 8);
        if (leadOn) {
          const leadHz = degHz(root + 7 + motifNote);
          const leadDur = STEP * (kind === "breakdown" ? 3 : 1.8);
          this.playLead(leadHz, at, leadDur / STEP);
        }
      }
    }
  }

  // Supersaw pad — 7 detuned sawtooth voices summed through a slow
  // lowpass sweep. Classic trance/progressive EDM pad texture. Held
  // for 4 bars (one per chord). Attack slow enough to feel like it
  // blooms into position; release tail overlaps the next chord's
  // attack for smooth transitions.
  private playPad(notes: number[], at: number): void {
    const ctx = this.ctx!;
    const bus = this.melodicBus;
    if (!bus) return;
    const dur = BEAT * 16 + 0.6; // 4 bars + tail

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, at);
    lp.frequency.linearRampToValueAtTime(2600, at + 1.5);
    lp.frequency.linearRampToValueAtTime(1800, at + dur);
    lp.Q.value = 0.9;
    lp.connect(bus);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.085, at + 0.8);          // slow bloom
    g.gain.setValueAtTime(0.085, at + dur - 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(lp);

    // Gentle tremolo so the pad doesn't feel static.
    const trem = ctx.createOscillator();
    trem.frequency.value = 0.35;
    const tremAmt = ctx.createGain();
    tremAmt.gain.value = 0.012;
    trem.connect(tremAmt);
    tremAmt.connect(g.gain);
    trem.start(at);
    trem.stop(at + dur + 0.1);

    // 7 detuned saws per note — supersaw stack.
    const detunes = [-14, -9, -5, 0, 5, 9, 14];
    for (const f of notes) {
      for (const d of detunes) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        o.detune.value = d;
        const voiceGain = ctx.createGain();
        voiceGain.gain.value = 0.14;
        o.connect(voiceGain);
        voiceGain.connect(g);
        o.start(at);
        o.stop(at + dur + 0.05);
      }
    }
    if (this.reverb) {
      const send = ctx.createGain();
      send.gain.value = 0.4;
      lp.connect(send);
      send.connect(this.reverb);
    }
  }

  // Sub bass — deep sine + filtered saw octave-up for presence. Held
  // for a musical duration (half a bar by default).
  private playSub(freq: number, at: number, duration: number): void {
    const ctx = this.ctx!;
    const bus = this.melodicBus;
    if (!bus) return;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 500;
    lp.Q.value = 0.8;
    lp.connect(bus);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.3, at + 0.01);
    g.gain.setValueAtTime(0.3, at + duration - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    g.connect(lp);

    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = freq * 0.5; // one octave below the passed freq
    sub.connect(g);
    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.value = freq;
    const bodyG = ctx.createGain();
    bodyG.gain.value = 0.35;
    body.connect(bodyG);
    bodyG.connect(g);

    sub.start(at); body.start(at);
    sub.stop(at + duration + 0.05);
    body.stop(at + duration + 0.05);
  }

  // Kick drum — pitch-drop sine plus a noise "click" at the onset.
  private playKick(at: number): void {
    const ctx = this.ctx!;
    const bus = this.drumBus;
    if (!bus) return;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.7, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
    g.connect(bus);

    // Sine with a fast downward sweep for thump.
    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(180, at);
    body.frequency.exponentialRampToValueAtTime(45, at + 0.09);
    body.connect(g);
    body.start(at);
    body.stop(at + 0.3);

    // Click layer — 3ms of filtered noise for the transient.
    const sr = ctx.sampleRate;
    const clickLen = Math.floor(sr * 0.01);
    const clickBuf = ctx.createBuffer(1, clickLen, sr);
    const cd = clickBuf.getChannelData(0);
    for (let i = 0; i < clickLen; i++) cd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / clickLen, 3);
    const click = ctx.createBufferSource();
    click.buffer = clickBuf;
    const clickFilt = ctx.createBiquadFilter();
    clickFilt.type = "bandpass";
    clickFilt.frequency.value = 4000;
    clickFilt.Q.value = 0.7;
    const clickG = ctx.createGain();
    clickG.gain.value = 0.18;
    click.connect(clickFilt);
    clickFilt.connect(clickG);
    clickG.connect(bus);
    click.start(at);
    click.stop(at + 0.02);
  }

  // Snare — bandpassed noise burst + a quick tone body.
  private playSnare(at: number): void {
    const ctx = this.ctx!;
    const bus = this.drumBus;
    if (!bus) return;
    const dur = 0.16;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = 1800;
    filt.Q.value = 1.0;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.26, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    src.connect(filt);
    filt.connect(g);
    g.connect(bus);
    src.start(at);
    src.stop(at + dur + 0.02);

    // Tone body for more "snap".
    const tone = ctx.createOscillator();
    tone.type = "triangle";
    tone.frequency.setValueAtTime(220, at);
    tone.frequency.exponentialRampToValueAtTime(120, at + 0.06);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, at);
    tg.gain.exponentialRampToValueAtTime(0.1, at + 0.003);
    tg.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
    tone.connect(tg);
    tg.connect(bus);
    tone.start(at);
    tone.stop(at + 0.14);
  }

  // Closed hi-hat — short filtered noise. `level` scales peak so the
  // scheduler can pick half-loudness hats for breakdown sections.
  private playHat(at: number, level: number = 0.045): void {
    const ctx = this.ctx!;
    const bus = this.drumBus;
    if (!bus) return;
    const dur = 0.035;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = "highpass";
    filt.frequency.value = 7500;
    filt.Q.value = 0.9;

    const g = ctx.createGain();
    g.gain.setValueAtTime(level, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    src.connect(filt);
    filt.connect(g);
    g.connect(bus);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  // Arp note — single saw with a steep lowpass-cutoff envelope. This
  // is the canonical "plucky" synth-arp character. Short envelope so
  // fast 16th sequences stay clean.
  private playArpNote(freq: number, at: number, duration: number): void {
    const ctx = this.ctx!;
    const bus = this.melodicBus;
    if (!bus) return;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 6.0; // resonant
    lp.frequency.setValueAtTime(5500, at);
    lp.frequency.exponentialRampToValueAtTime(700, at + duration);
    lp.connect(bus);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.13, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    g.connect(lp);

    const saw = ctx.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = freq;
    const sq = ctx.createOscillator();
    sq.type = "square";
    sq.frequency.value = freq * 0.5;
    const sqG = ctx.createGain();
    sqG.gain.value = 0.25;
    sq.connect(sqG);
    sqG.connect(g);
    saw.connect(g);

    saw.start(at); sq.start(at);
    saw.stop(at + duration + 0.02);
    sq.stop(at + duration + 0.02);

    if (this.reverb) {
      const send = ctx.createGain();
      send.gain.value = 0.22;
      g.connect(send);
      send.connect(this.reverb);
    }
  }

  // Sidechain pump — ducks the melodicBus gain sharply on kick and
  // springs it back over ~0.28s. The classic EDM "breathing" feel.
  // Safe to call even when music is suppressed; the melodicBus is
  // separate from the suppression gain staging on musicBus.
  private pumpMelodicBus(at: number): void {
    const ctx = this.ctx;
    const mb = this.melodicBus;
    if (!ctx || !mb) return;
    try {
      mb.gain.cancelScheduledValues(at);
      mb.gain.setValueAtTime(1.0, at);
      mb.gain.linearRampToValueAtTime(0.38, at + 0.04);
      mb.gain.linearRampToValueAtTime(1.0,  at + 0.28);
    } catch {}
  }

  // Optional glockenspiel/sparkle one-shot — used by UI (achievement
  // fanfare) not by the music composer. Kept around because the
  // UI palette calls it for the high-bell tail of sound.achievement().
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
  // Lead synth — hardware-flavored saw through a resonant lowpass with
  // a filter-cutoff bloom envelope. Routes through melodicBus so the
  // sidechain pump applies (on each kick the lead ducks with the pad).
  private playLead(freq: number, at: number, durSteps: number): void {
    const ctx = this.ctx!;
    const bus = this.melodicBus;
    if (!bus) return;
    const dur = Math.max(0.18, durSteps * STEP);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 3.2;                               // resonant
    lp.frequency.setValueAtTime(1200, at);
    lp.frequency.exponentialRampToValueAtTime(3800, at + dur * 0.25);
    lp.frequency.linearRampToValueAtTime(1400, at + dur);
    lp.connect(bus);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.14, at + 0.015);   // fast attack
    g.gain.setValueAtTime(0.14, at + dur - 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(lp);

    // Detuned double-saw for width + a sub sine for body.
    const saw1 = ctx.createOscillator();
    saw1.type = "sawtooth";
    saw1.frequency.value = freq;
    saw1.detune.value = -7;
    const saw2 = ctx.createOscillator();
    saw2.type = "sawtooth";
    saw2.frequency.value = freq;
    saw2.detune.value = +7;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = freq * 0.5;
    const subG = ctx.createGain();
    subG.gain.value = 0.28;
    sub.connect(subG);
    subG.connect(g);

    // Light vibrato ramping in on held notes so sustained tones don't
    // feel dead.
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.5;
    const vibAmt = ctx.createGain();
    vibAmt.gain.setValueAtTime(0, at);
    vibAmt.gain.linearRampToValueAtTime(7, at + dur * 0.4); // cents
    vib.connect(vibAmt);
    vibAmt.connect(saw1.detune);
    vibAmt.connect(saw2.detune);

    saw1.connect(g); saw2.connect(g);
    saw1.start(at); saw2.start(at); sub.start(at); vib.start(at);
    saw1.stop(at + dur + 0.05);
    saw2.stop(at + dur + 0.05);
    sub.stop(at + dur + 0.05);
    vib.stop(at + dur + 0.05);

    if (this.reverb) {
      const send = ctx.createGain();
      send.gain.value = 0.35;
      g.connect(send);
      send.connect(this.reverb);
    }
  }

  // --- the palette ---

  /** Pick a variant index that isn't the same as the previous call.
   *  Breaks up the feel-of-same when the user scans UI rapidly. */
  private nextVariant(count: number, last: number): number {
    if (count <= 1) return 0;
    let v = Math.floor(Math.random() * count);
    if (v === last) v = (v + 1) % count;
    return v;
  }

  /** Primary action click — terran-console button press. Rotates through
   *  three tonal variants (short bleeps/arpeggios, not percussive ticks)
   *  so consecutive clicks never sound identical. All variants in D
   *  dorian so they sit cohesively with the soundtrack. */
  click(): void {
    this.resumeIfNeeded();
    if (!this.enabled) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const variant = this.nextVariant(3, this.lastClickVariant);
    this.lastClickVariant = variant;

    if (variant === 0) {
      // "Acknowledged" — two-note rising arpeggio A5 → E6, bright
      // square with a brief noise onset.
      this.playNoise({
        duration: 0.02, peak: 0.18,
        filter: { type: "highpass", freq: 2800 },
        startAt: t,
      });
      this.playOsc({
        freq: 880, type: "square",
        attack: 0.002, decay: 0.08, peak: 0.22,
        filter: { type: "lowpass", freq: 3200, Q: 2 },
        reverbSend: 0.35, startAt: t,
      });
      this.playOsc({
        freq: 1318.51, type: "square",
        attack: 0.002, decay: 0.1, peak: 0.22,
        filter: { type: "lowpass", freq: 4000, Q: 2 },
        reverbSend: 0.45, startAt: t + 0.05,
      });
    } else if (variant === 1) {
      // "Select" — downward bip C6 → A5, plasticky square with a
      // sharp high tick on top.
      this.playOsc({
        freq: 1046.5, freqEnd: 880, type: "square",
        attack: 0.002, decay: 0.09, peak: 0.26,
        filter: { type: "bandpass", freq: 1800, Q: 2.4 },
        reverbSend: 0.4, startAt: t,
      });
      this.playOsc({
        freq: 3520, type: "sine",
        attack: 0.001, decay: 0.03, peak: 0.14,
        filter: { type: "highpass", freq: 2500 },
        reverbSend: 0.3, startAt: t,
      });
      this.playNoise({
        duration: 0.015, peak: 0.12,
        filter: { type: "highpass", freq: 4000 },
        startAt: t,
      });
    } else {
      // "Switch" — staccato major-third stab E6 + G#6 stacked,
      // triangle body + square punch. Reads as a hard flip.
      this.playOsc({
        freq: 1318.51, type: "triangle",
        attack: 0.002, decay: 0.08, peak: 0.28,
        filter: { type: "lowpass", freq: 3800 },
        reverbSend: 0.4, startAt: t,
      });
      this.playOsc({
        freq: 1661.22, type: "square",
        attack: 0.002, decay: 0.06, peak: 0.12,
        filter: { type: "bandpass", freq: 2200, Q: 3.2 },
        reverbSend: 0.5, startAt: t,
      });
      this.playNoise({
        duration: 0.018, peak: 0.14,
        filter: { type: "highpass", freq: 3200 },
        startAt: t,
      });
    }
    this.duckMusic(0.4, 0.22);
  }

  /** Hover acknowledge — four-variant pool of short tonal bleeps with
   *  Starcraft-Terran-console character. Not a percussive tick; each
   *  variant is a brief synthesized voice (~80-120ms) in D dorian with
   *  a distinct pitch + contour so consecutive hovers read as varied
   *  rather than identical. Rate-limited to ~45ms so dense scanning
   *  still feels snappy. */
  hover(): void {
    this.resumeIfNeeded();
    if (!this.enabled) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (now - this.lastHover < 0.045) return;
    this.lastHover = now;
    const variant = this.nextVariant(4, this.lastHoverVariant);
    this.lastHoverVariant = variant;
    const t = now;

    // Small random detune on every variant so even repeated hits on
    // the same variant don't sound bit-identical.
    const jitter = (Math.random() - 0.5) * 14; // ±7 cents

    if (variant === 0) {
      // V0: Upward chirp A5 → E6, sine + square blend. The "bip" that
      //     anchors the palette.
      this.playOsc({
        freq: 880, freqEnd: 1318.51, type: "sine",
        attack: 0.002, decay: 0.09, peak: 0.3,
        filter: { type: "lowpass", freq: 3500, Q: 1.4 },
        reverbSend: 0.35, startAt: t, detune: jitter,
      });
      this.playOsc({
        freq: 880, freqEnd: 1318.51, type: "square",
        attack: 0.002, decay: 0.07, peak: 0.08,
        filter: { type: "bandpass", freq: 2200, Q: 2.2 },
        reverbSend: 0.45, startAt: t, detune: jitter,
      });
    } else if (variant === 1) {
      // V1: Two-note "bip-bop" E6 → G6, ultra-short sine. Fastest of
      //     the pool; reads as "focus acknowledged".
      this.playOsc({
        freq: 1318.51, type: "sine",
        attack: 0.001, decay: 0.04, peak: 0.28,
        filter: { type: "lowpass", freq: 3800 },
        reverbSend: 0.4, startAt: t, detune: jitter,
      });
      this.playOsc({
        freq: 1567.98, type: "sine",
        attack: 0.001, decay: 0.05, peak: 0.22,
        filter: { type: "lowpass", freq: 4200 },
        reverbSend: 0.45, startAt: t + 0.03, detune: jitter,
      });
    } else if (variant === 2) {
      // V2: Single G5 pulse with a filter sweep — Terran "console
      //     blip". Body is triangle; bandpass sweep gives it that
      //     electrostatic pluck character.
      this.playOsc({
        freq: 783.99, type: "triangle",
        attack: 0.002, decay: 0.1, peak: 0.32,
        filter: { type: "bandpass", freq: 1600, Q: 3 },
        reverbSend: 0.4, startAt: t, detune: jitter,
      });
      this.playOsc({
        freq: 1567.98, type: "sine",
        attack: 0.001, decay: 0.05, peak: 0.12,
        filter: { type: "highpass", freq: 2000 },
        reverbSend: 0.5, startAt: t + 0.005, detune: jitter,
      });
    } else {
      // V3: Downward C6 → A5 with a hint of noise — "readout tick".
      //     Slightly longer; used as a "resting" contrast to the
      //     rising variants.
      this.playOsc({
        freq: 1046.5, freqEnd: 880, type: "sine",
        attack: 0.002, decay: 0.11, peak: 0.26,
        filter: { type: "lowpass", freq: 3200, Q: 1.8 },
        reverbSend: 0.35, startAt: t, detune: jitter,
      });
      this.playOsc({
        freq: 2093, freqEnd: 1760, type: "sine",
        attack: 0.002, decay: 0.07, peak: 0.1,
        filter: { type: "highpass", freq: 1800 },
        reverbSend: 0.5, startAt: t, detune: jitter,
      });
      this.playNoise({
        duration: 0.012, peak: 0.08,
        filter: { type: "highpass", freq: 4000 },
        startAt: t,
      });
    }
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
