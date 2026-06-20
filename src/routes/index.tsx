import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Fretwise — Learn the Guitar Fretboard" },
      {
        name: "description",
        content:
          "Practice guitar notes with mic pitch detection, tuner, tolerance and play-along mode.",
      },
    ],
  }),
  component: Index,
});

/* ───────── Music ───────── */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const STRINGS = [
  { name: "E", openMidi: 64 }, // 1 high E (top)
  { name: "B", openMidi: 59 },
  { name: "G", openMidi: 55 },
  { name: "D", openMidi: 50 },
  { name: "A", openMidi: 45 },
  { name: "E", openMidi: 40 }, // 6 low E (bottom)
];
const FRETS = 12;
const midiToName = (m: number) => NOTE_NAMES[((m % 12) + 12) % 12];
const midiToOctave = (m: number) => Math.floor(m / 12) - 1;
const midiAt = (s: number, f: number) => STRINGS[s].openMidi + f;
const noteAt = (s: number, f: number) => midiToName(midiAt(s, f));
const freqToMidiFloat = (f: number) => 69 + 12 * Math.log2(f / 440);

const NOTE_COLORS: Record<string, string> = {
  C: "#ef4444", "C#": "#f97316", D: "#f59e0b", "D#": "#eab308",
  E: "#84cc16", F: "#22c55e", "F#": "#14b8a6", G: "#06b6d4",
  "G#": "#3b82f6", A: "#8b5cf6", "A#": "#d946ef", B: "#ec4899",
};

type Mode = "find-note" | "name-note" | "guitar" | "all-strings" | "scale" | "play-along";
type Feedback = "idle" | "correct" | "wrong";
type Target = { stringIdx: number; fret: number; note: string; midi: number };

function randomTarget(strings: number[], notes: string[]): Target {
  const S = strings.length ? strings : [0, 1, 2, 3, 4, 5];
  const N = notes.length ? notes : NOTE_NAMES;
  const cands: Target[] = [];
  for (const s of S)
    for (let f = 0; f <= FRETS; f++) {
      const n = noteAt(s, f);
      if (N.includes(n)) cands.push({ stringIdx: s, fret: f, note: n, midi: midiAt(s, f) });
    }
  if (!cands.length) return { stringIdx: 0, fret: 0, note: noteAt(0, 0), midi: midiAt(0, 0) };
  return cands[Math.floor(Math.random() * cands.length)];
}

function randomNote(allowedNotes: string[]): string {
  const N = allowedNotes.length ? allowedNotes : NOTE_NAMES;
  return N[Math.floor(Math.random() * N.length)];
}

function pickChoices(correct: string, allowed: string[], n = 4): string[] {
  const pool = (allowed.length >= n ? allowed : NOTE_NAMES).filter((x) => x !== correct);
  const picks = new Set<string>();
  while (picks.size < n - 1 && pool.length) picks.add(pool[Math.floor(Math.random() * pool.length)]);
  const arr = [correct, ...Array.from(picks)];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ───────── Pitch ───────── */

function autoCorrelate(buf: Float32Array, sampleRate: number): number {
  let SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;
  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  buf = buf.slice(r1, r2);
  SIZE = buf.length;
  const c = new Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) for (let j = 0; j < SIZE - i; j++) c[i] += buf[j] * buf[j + i];
  let d = 0;
  while (c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < SIZE; i++) if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  let T0 = maxpos;
  if (T0 <= 0) return -1;
  const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);
  return sampleRate / T0;
}

/* ───────── FX ───────── */

let fxCtx: AudioContext | null = null;
function ensureFx() {
  if (typeof window === "undefined") return null;
  if (!fxCtx) fxCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return fxCtx;
}
function playTone(kind: "correct" | "wrong" | "tick", enabled: boolean) {
  if (!enabled) return;
  const ctx = ensureFx(); if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.connect(g); g.connect(ctx.destination);
  if (kind === "correct") {
    o.type = "sine"; o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start(t); o.stop(t + 0.3);
  } else if (kind === "wrong") {
    o.type = "square"; o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.start(t); o.stop(t + 0.22);
  } else {
    o.type = "triangle"; o.frequency.setValueAtTime(660, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.start(t); o.stop(t + 0.1);
  }
}

/* ───────── Component ───────── */

type CellStat = { attempts: number; correct: number };

function Index() {
  const [mode, setMode] = useState<Mode>("find-note");
  const [allowedStrings, setAllowedStrings] = useState<number[]>([0, 1, 2, 3, 4, 5]);
  const [allowedNotes, setAllowedNotes] = useState<string[]>([...NOTE_NAMES]);
  const [target, setTarget] = useState<Target>({
    stringIdx: 0, fret: 0, note: noteAt(0, 0), midi: midiAt(0, 0),
  });
  const [choices, setChoices] = useState<string[]>([]);
  const [mounted, setMounted] = useState(false);

  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [perCell, setPerCell] = useState<Record<string, CellStat>>({});
  const [completed, setCompleted] = useState<Set<string>>(new Set());

  const [detectedFreq, setDetectedFreq] = useState<number | null>(null);
  const [detectedMidi, setDetectedMidi] = useState<number | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>("idle");
  const [showAll, setShowAll] = useState(false);

  const [tolerance, setTolerance] = useState(25);
  const [soundOn, setSoundOn] = useState(true);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [isFs, setIsFs] = useState(false);

  const [stringsHit, setStringsHit] = useState<Set<number>>(new Set());
  const [speed, setSpeed] = useState(2); // seconds between play-along notes

  const [tourStep, setTourStep] = useState(-1);

  const audioRef = useRef<{ ctx: AudioContext; stream: MediaStream; analyser: AnalyserNode; raf: number } | null>(null);
  const lastCorrectRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  /* ── Lifecycle ── */
  useEffect(() => {
    setMounted(true);
    nextTarget();
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if ((mode === "guitar" || mode === "find-note" || mode === "all-strings") && !micOn) startMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => () => stopMic(), []);

  // Play-along auto-cycle
  useEffect(() => {
    if (mode !== "play-along") return;
    const id = setInterval(() => {
      const n = randomNote(allowedNotes);
      setTarget({ stringIdx: 0, fret: 0, note: n, midi: midiAt(0, 0) });
    }, Math.max(400, speed * 1000));
    return () => clearInterval(id);
  }, [mode, speed, allowedNotes]);

  /* ── Flow ── */
  const cellKey = (s: number, f: number) => `${s}:${f}`;

  const nextTarget = useCallback(() => {
    if (mode === "play-along") {
      setTarget({ stringIdx: 0, fret: 0, note: randomNote(allowedNotes), midi: midiAt(0, 0) });
    } else {
      const t = randomTarget(allowedStrings, allowedNotes);
      setTarget(t);
      setChoices(pickChoices(t.note, allowedNotes));
    }
    setStringsHit(new Set());
    setFeedback("idle");
  }, [allowedStrings, allowedNotes, mode]);

  const recordAttempt = (s: number, f: number, ok: boolean) => {
    setAttempts((a) => a + 1);
    if (ok) setCorrectCount((c) => c + 1);
    setPerCell((p) => {
      const k = cellKey(s, f);
      const cur = p[k] || { attempts: 0, correct: 0 };
      return { ...p, [k]: { attempts: cur.attempts + 1, correct: cur.correct + (ok ? 1 : 0) } };
    });
  };

  const handleCorrect = () => {
    const now = Date.now();
    if (now - lastCorrectRef.current < 600) return;
    lastCorrectRef.current = now;
    const t = targetRef.current;
    recordAttempt(t.stringIdx, t.fret, true);
    setCompleted((c) => new Set(c).add(cellKey(t.stringIdx, t.fret)));
    setScore((s) => s + 1);
    setStreak((s) => { const n = s + 1; setBestStreak((b) => Math.max(b, n)); return n; });
    setFeedback("correct");
    playTone("correct", soundOn);
    setTimeout(nextTarget, 650);
  };

  const handleWrong = () => {
    const t = targetRef.current;
    recordAttempt(t.stringIdx, t.fret, false);
    setStreak(0);
    setFeedback("wrong");
    playTone("wrong", soundOn);
    setTimeout(() => setFeedback("idle"), 450);
  };

  /* ── Aggregates ── */
  const noteAcc = useMemo(() => {
    const out: Record<string, CellStat> = {};
    for (const k in perCell) {
      const [s, f] = k.split(":").map(Number);
      const n = noteAt(s, f);
      const c = perCell[k];
      out[n] = out[n] || { attempts: 0, correct: 0 };
      out[n].attempts += c.attempts;
      out[n].correct += c.correct;
    }
    return out;
  }, [perCell]);

  const totalPositions = useMemo(() => {
    let n = 0;
    for (const s of allowedStrings)
      for (let f = 0; f <= FRETS; f++) if (allowedNotes.includes(noteAt(s, f))) n++;
    return n;
  }, [allowedStrings, allowedNotes]);

  const completedInScope = useMemo(() => {
    let n = 0;
    completed.forEach((k) => {
      const [s, f] = k.split(":").map(Number);
      if (allowedStrings.includes(s) && allowedNotes.includes(noteAt(s, f))) n++;
    });
    return n;
  }, [completed, allowedStrings, allowedNotes]);

  const accuracy = attempts ? Math.round((correctCount / attempts) * 100) : 0;

  /* ── Mic ── */
  async function startMic() {
    if (audioRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        const f = autoCorrelate(buf, ctx.sampleRate);
        if (f > 60 && f < 1400) { setDetectedFreq(f); setDetectedMidi(freqToMidiFloat(f)); }
        else { setDetectedFreq(null); setDetectedMidi(null); }
        audioRef.current!.raf = requestAnimationFrame(tick);
      };
      audioRef.current = { ctx, stream, analyser, raf: requestAnimationFrame(tick) };
      setMicOn(true);
    } catch { alert("Microphone permission denied or unavailable."); }
  }
  function stopMic() {
    if (!audioRef.current) return;
    cancelAnimationFrame(audioRef.current.raf);
    audioRef.current.stream.getTracks().forEach((t) => t.stop());
    audioRef.current.ctx.close();
    audioRef.current = null;
    setMicOn(false); setDetectedFreq(null); setDetectedMidi(null);
  }

  /* ── Mic-driven answering ── */
  useEffect(() => {
    if (!detectedMidi || feedback !== "idle") return;
    if (mode !== "find-note" && mode !== "guitar" && mode !== "all-strings") return;
    if (mode === "all-strings") {
      for (const s of allowedStrings) {
        if (stringsHit.has(s)) continue;
        for (let f = 0; f <= FRETS; f++) {
          if (noteAt(s, f) !== target.note) continue;
          const cents = (detectedMidi - midiAt(s, f)) * 100;
          if (Math.abs(cents) <= tolerance) {
            const newHits = new Set(stringsHit).add(s);
            setStringsHit(newHits);
            playTone("tick", soundOn);
            recordAttempt(s, f, true);
            setCompleted((c) => new Set(c).add(cellKey(s, f)));
            if (newHits.size === allowedStrings.length) {
              setScore((x) => x + 1);
              setStreak((s2) => { const n = s2 + 1; setBestStreak((b) => Math.max(b, n)); return n; });
              setFeedback("correct");
              playTone("correct", soundOn);
              setTimeout(nextTarget, 700);
            }
            return;
          }
        }
      }
      return;
    }
    const cents = (detectedMidi - target.midi) * 100;
    if (Math.abs(cents) <= tolerance) handleCorrect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedMidi, target, feedback, mode, tolerance, allowedStrings, stringsHit]);

  /* ── Tuner ── */
  const tunerInfo = useMemo(() => {
    if (!detectedMidi) return null;
    let bestIdx = 0, bestDiff = Infinity;
    STRINGS.forEach((s, i) => {
      const d = Math.abs(detectedMidi - s.openMidi);
      if (d < bestDiff) { bestDiff = d; bestIdx = i; }
    });
    const best = STRINGS[bestIdx];
    return { string: best, idx: bestIdx, cents: (detectedMidi - best.openMidi) * 100 };
  }, [detectedMidi]);

  /* ── Fullscreen ── */
  const toggleFs = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {}
  };

  const toggleString = (i: number) =>
    setAllowedStrings((cur) => {
      const has = cur.includes(i);
      const nxt = has ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b);
      return nxt.length ? nxt : cur;
    });
  const toggleNote = (n: string) =>
    setAllowedNotes((cur) => {
      const has = cur.includes(n);
      const nxt = has ? cur.filter((x) => x !== n) : [...cur, n];
      return nxt.length ? nxt : cur;
    });

  /* ── Tour ── */
  const TOUR: { sel: string; text: string }[] = [
    { sel: "tour-modes", text: "Choose a practice mode here." },
    { sel: "tour-tuner", text: "Tuner button — tune your guitar before playing." },
    { sel: "tour-showall", text: "Toggle showing every note on the fretboard." },
    { sel: "tour-tolerance", text: "Pitch tolerance — how close your mic pitch must match (in cents)." },
    { sel: "tour-strings", text: "Pick which strings to practice." },
    { sel: "tour-notes", text: "Pick which notes to focus on." },
    { sel: "tour-challenge", text: "The current challenge — note name (large) and string number (small)." },
    { sel: "tour-fretboard", text: "The fretboard. Fret 0 is the nut; markers sit between G and D." },
    { sel: "tour-choices", text: "Tap the correct note name to answer." },
    { sel: "tour-noterow", text: "Per-note accuracy across your session." },
    { sel: "tour-header", text: "Score, accuracy, sound, fullscreen and Tour live up here." },
  ];
  const closeTour = () => setTourStep(-1);

  /* ── Render helpers ── */
  const fretboard = (
    <Fretboard
      target={target}
      showAll={showAll}
      hideTargetName={mode === "find-note" || mode === "guitar" || mode === "name-note"}
      highlightNote={mode === "scale" || mode === "play-along" ? target.note : null}
      feedback={feedback}
      allowedStrings={allowedStrings}
      stringsHit={mode === "all-strings" ? stringsHit : null}
      tourId="tour-fretboard"
    />
  );

  const challenge = (
    <div
      data-tour="tour-challenge"
      className={`rounded-2xl px-4 py-2 border text-center transition-colors ${
        feedback === "correct" ? "bg-emerald-500/15 border-emerald-500/40"
        : feedback === "wrong" ? "bg-rose-500/15 border-rose-500/40"
        : "bg-zinc-900/60 border-zinc-800"
      }`}
    >
      <div className="text-5xl sm:text-6xl font-black font-mono leading-none" style={{ color: NOTE_COLORS[target.note] }}>
        {target.note}
      </div>
      {mode !== "play-along" && mode !== "scale" && (
        <div className="text-xs sm:text-sm text-zinc-400 font-mono mt-1">
          string {target.stringIdx + 1}
        </div>
      )}
    </div>
  );

  const choicesRow = (mode === "find-note" || mode === "name-note" || mode === "guitar") && (
    <div data-tour="tour-choices" className="grid grid-cols-4 gap-2">
      {(mounted ? choices : ["", "", "", ""]).map((n, i) => (
        <button
          key={i}
          onClick={() => n && (n === target.note ? handleCorrect() : handleWrong())}
          className="px-2 py-2 sm:py-3 rounded-xl bg-zinc-800 hover:bg-amber-400 hover:text-zinc-900 text-lg font-extrabold font-mono"
          style={n ? { borderTop: `3px solid ${NOTE_COLORS[n]}` } : undefined}
        >
          {n || "\u00A0"}
        </button>
      ))}
    </div>
  );

  const noteAccRow = (
    <div data-tour="tour-noterow" className="grid gap-1" style={{ gridTemplateColumns: `repeat(${allowedNotes.length || 12}, minmax(0,1fr))` }}>
      {(allowedNotes.length ? allowedNotes : NOTE_NAMES).map((n) => {
        const st = noteAcc[n];
        const pct = st && st.attempts ? Math.round((st.correct / st.attempts) * 100) : null;
        return (
          <div key={n} className="rounded-md bg-zinc-900/70 border border-zinc-800 py-1 text-center">
            <div className="text-sm font-extrabold font-mono" style={{ color: NOTE_COLORS[n] }}>{n}</div>
            <div className="text-[9px] font-mono text-zinc-400 leading-none">{pct === null ? "—" : `${pct}%`}</div>
          </div>
        );
      })}
    </div>
  );

  /* ── Fullscreen view: fretboard + challenge only ── */
  if (isFs) {
    return (
      <div ref={rootRef} className="h-[100dvh] w-screen bg-[#0e0e12] text-zinc-100 flex flex-col p-3 gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1">{challenge}</div>
          <button onClick={toggleFs} className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-sm">Exit</button>
        </div>
        <div className="flex-1 min-h-0 flex items-center">
          <div className="w-full">{fretboard}</div>
        </div>
        {choicesRow}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="min-h-[100dvh] bg-[#0e0e12] text-zinc-100 overflow-y-auto flex flex-col">
      <div className="mx-auto w-full max-w-6xl px-3 py-2 flex flex-col gap-2 flex-1">

        {/* HEADER */}
        <header data-tour="tour-header" className="flex items-center justify-between gap-2">
          <h1 className="text-lg sm:text-2xl font-extrabold tracking-tight shrink-0">
            Fret<span className="text-amber-400">wise</span>
          </h1>
          <div className="flex items-center gap-1">
            <Stat label="Score" value={score} />
            <Stat label="Streak" value={streak} />
            <Stat label="Acc" value={`${accuracy}%`} />
            <IconBtn onClick={() => setSoundOn((s) => !s)} title="Sound">{soundOn ? "🔊" : "🔇"}</IconBtn>
            <IconBtn onClick={toggleFs} title="Fullscreen">⛶</IconBtn>
            <IconBtn onClick={() => setTourStep(0)} title="Tour">?</IconBtn>
          </div>
        </header>

        {/* MODE + TUNER + SHOW ALL */}
        <div data-tour="tour-modes" className="flex flex-wrap items-center gap-1.5">
          <button
            data-tour="tour-tuner"
            onClick={() => { setTunerOpen(true); if (!micOn) startMic(); }}
            className="px-2.5 py-1.5 rounded-full text-xs sm:text-sm font-semibold bg-emerald-500 text-zinc-900 hover:bg-emerald-400"
          >
            🎚 Tuner
          </button>
          {(
            [
              ["find-note", "Find"],
              ["name-note", "Name"],
              ["guitar", "Guitar 🎸"],
              ["all-strings", "All Strings"],
              ["play-along", "Play-Along"],
              ["scale", "Free Play"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => { setMode(m); setTimeout(nextTarget, 0); }}
              className={`px-2.5 py-1.5 rounded-full text-xs sm:text-sm font-semibold transition ${
                mode === m ? "bg-amber-400 text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            data-tour="tour-showall"
            onClick={() => setShowAll((s) => !s)}
            className="ml-auto px-2.5 py-1.5 rounded-full text-xs bg-zinc-800 hover:bg-zinc-700"
          >
            {showAll ? "Hide notes" : "Show notes"}
          </button>
        </div>

        {/* TOLERANCE + SPEED */}
        <div className="grid grid-cols-2 gap-2">
          <div data-tour="tour-tolerance" className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
            <div className="flex items-center justify-between text-[10px]">
              <span className="uppercase tracking-wider text-zinc-500">Tolerance</span>
              <span className="font-mono text-amber-400">±{tolerance}¢</span>
            </div>
            <input type="range" min={5} max={50} step={1} value={tolerance}
              onChange={(e) => setTolerance(Number(e.target.value))}
              className="w-full accent-amber-400" />
          </div>
          <div className={`rounded-lg border bg-zinc-900/60 px-2 py-1.5 ${mode === "play-along" ? "border-amber-500/50" : "border-zinc-800"}`}>
            <div className="flex items-center justify-between text-[10px]">
              <span className="uppercase tracking-wider text-zinc-500">Speed (play-along)</span>
              <span className="font-mono text-amber-400">{speed.toFixed(1)}s</span>
            </div>
            <input type="range" min={0.5} max={6} step={0.1} value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="w-full accent-amber-400" />
          </div>
        </div>

        {/* PRACTICE FILTERS (strings + notes selection — no per-cell %) */}
        <div className="grid grid-cols-2 gap-2">
          <div data-tour="tour-strings" className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Strings</div>
            <div className="grid grid-cols-3 gap-1">
              {STRINGS.map((s, i) => {
                const on = allowedStrings.includes(i);
                return (
                  <button key={i} onClick={() => toggleString(i)}
                    className={`px-1 py-1 rounded-md border font-bold text-sm transition ${
                      on ? "bg-amber-400 text-zinc-900 border-amber-400" : "bg-zinc-800/60 text-zinc-500 border-zinc-700 opacity-50"
                    }`}>
                    {i + 1}·{s.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div data-tour="tour-notes" className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Notes</div>
            <div className="grid grid-cols-6 gap-1">
              {NOTE_NAMES.map((n) => {
                const on = allowedNotes.includes(n);
                return (
                  <button key={n} onClick={() => toggleNote(n)}
                    className={`px-1 py-1 rounded-md border font-bold text-xs font-mono transition ${
                      on ? "bg-amber-400 text-zinc-900 border-amber-400" : "bg-zinc-800/60 text-zinc-500 border-zinc-700 opacity-50"
                    }`}>
                    {n}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* CHALLENGE */}
        {challenge}

        {/* FRETBOARD */}
        {fretboard}

        {/* CHOICES */}
        {choicesRow}

        {/* PER-NOTE ACCURACY ROW */}
        {noteAccRow}

        {/* MIC + COVERAGE INLINE */}
        <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
          <div className="font-mono">
            🎤 {detectedMidi !== null
              ? `${midiToName(Math.round(detectedMidi))}${midiToOctave(Math.round(detectedMidi))} · ${detectedFreq?.toFixed(0)}Hz`
              : micOn ? "listening…" : "mic off"}
          </div>
          <div>Coverage {completedInScope}/{totalPositions} · Best {bestStreak}</div>
          <button onClick={micOn ? stopMic : startMic}
            className={`px-2 py-1 rounded ${micOn ? "bg-rose-500 text-white" : "bg-amber-400 text-zinc-900"} font-bold`}>
            {micOn ? "Mic on" : "Enable mic"}
          </button>
        </div>
      </div>

      {/* TUNER MODAL */}
      {tunerOpen && (
        <div className="fixed inset-0 bg-black/70 z-40 flex items-center justify-center p-4" onClick={() => setTunerOpen(false)}>
          <div className="bg-zinc-900 border border-amber-400/40 rounded-2xl p-4 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm uppercase tracking-wider text-amber-400 font-bold">Tuner</div>
              <button onClick={() => setTunerOpen(false)} className="text-xs px-2 py-1 rounded bg-zinc-800">Close</button>
            </div>
            <Tuner info={tunerInfo} freq={detectedFreq} />
          </div>
        </div>
      )}

      {/* TOUR */}
      {tourStep >= 0 && tourStep < TOUR.length && (
        <TourOverlay
          step={TOUR[tourStep]}
          index={tourStep}
          total={TOUR.length}
          onNext={() => setTourStep((s) => (s + 1 >= TOUR.length ? -1 : s + 1))}
          onClose={closeTour}
        />
      )}
    </div>
  );
}

/* ───────── Subcomponents ───────── */

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="px-1.5 py-0.5 rounded bg-zinc-900/70 border border-zinc-800 text-right">
      <div className="text-[8px] uppercase text-zinc-500 leading-none">{label}</div>
      <div className="text-xs font-mono font-bold leading-tight">{value}</div>
    </div>
  );
}

function IconBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button onClick={onClick} title={title} suppressHydrationWarning
      className="w-8 h-8 rounded-md bg-zinc-800 hover:bg-zinc-700 text-sm flex items-center justify-center">
      {children}
    </button>
  );
}

function Tuner({
  info, freq,
}: {
  info: { string: { name: string; openMidi: number }; idx: number; cents: number } | null;
  freq: number | null;
}) {
  return (
    <div>
      <div className="flex gap-1 mb-2">
        {STRINGS.map((s, i) => (
          <div key={i}
            className={`flex-1 text-center py-1.5 rounded text-sm font-bold ${
              info && info.idx === i && Math.abs(info.cents) < 10 ? "bg-emerald-400 text-zinc-900"
              : info && info.idx === i ? "bg-amber-400 text-zinc-900"
              : "bg-zinc-800 text-zinc-400"
            }`}>
            {s.name}
          </div>
        ))}
      </div>
      <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-500" />
        {info && (
          <div className={`absolute top-0 bottom-0 ${Math.abs(info.cents) < 10 ? "bg-emerald-400" : "bg-amber-400"}`}
            style={{ left: "50%", width: `${Math.min(Math.abs(info.cents), 50)}%`,
              transform: info.cents < 0 ? "translateX(-100%)" : "none" }} />
        )}
      </div>
      <div className="mt-1 text-[11px] text-zinc-400 font-mono">
        {info ? `${info.string.name}  ${info.cents > 0 ? "+" : ""}${info.cents.toFixed(0)}¢  · ${freq?.toFixed(1)} Hz` : "Play an open string…"}
      </div>
    </div>
  );
}

function Fretboard({
  target, showAll, hideTargetName, highlightNote, feedback, allowedStrings, stringsHit, tourId,
}: {
  target: Target;
  showAll: boolean;
  hideTargetName: boolean;
  highlightNote: string | null;
  feedback: Feedback;
  allowedStrings: number[];
  stringsHit: Set<number> | null;
  tourId?: string;
}) {
  const inlayFrets = [3, 5, 7, 9, 12];
  // fret 0 narrower since it sits ON the nut
  const fretFlex = (f: number) => (f === 0 ? "0 0 28px" : "1 1 0");

  const FretNumRow = (
    <div className="flex items-center px-1">
      <div className="w-6 sm:w-7" />
      {Array.from({ length: FRETS + 1 }).map((_, f) => (
        <div key={f} style={{ flex: fretFlex(f) }} className="text-center text-[10px] sm:text-xs text-amber-300/80 font-bold font-mono">
          {f}
        </div>
      ))}
      <div className="w-6 sm:w-7" />
    </div>
  );

  return (
    <div data-tour={tourId} className="rounded-2xl border border-zinc-800 bg-gradient-to-b from-[#2a1d10] to-[#0f0b07] p-1.5 sm:p-3 overflow-hidden">
      {FretNumRow}
      <div className="w-full relative">
        {/* Inlay markers — positioned between G(sIdx=2) and D(sIdx=3) rows */}
        <div className="absolute left-0 right-0 pointer-events-none z-0 flex"
          style={{ top: "calc(50% - 6px)", height: "12px" }}>
          <div className="w-6 sm:w-7" />
          {Array.from({ length: FRETS + 1 }).map((_, f) => (
            <div key={f} style={{ flex: fretFlex(f) }} className="flex items-center justify-center">
              {inlayFrets.includes(f) && (
                f === 12 ? (
                  <div className="flex gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-amber-400/90 shadow-[0_0_6px_#d4af37]" />
                    <div className="w-2 h-2 rounded-full bg-amber-400/90 shadow-[0_0_6px_#d4af37]" />
                  </div>
                ) : (
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-400/90 shadow-[0_0_6px_#d4af37]" />
                )
              )}
            </div>
          ))}
          <div className="w-6 sm:w-7" />
        </div>

        {STRINGS.map((s, sIdx) => {
          const muted = !allowedStrings.includes(sIdx);
          const hit = stringsHit && stringsHit.has(sIdx);
          const thickness = Math.max(1, (sIdx + 1) * 0.7);
          // Find this string's note positions matching highlightNote
          return (
            <div key={sIdx}
              className={`flex items-center h-7 sm:h-9 transition-opacity relative ${muted ? "opacity-25" : "opacity-100"}`}>
              <div className="w-6 sm:w-7 text-center text-sm sm:text-base font-extrabold text-amber-300 font-mono">{s.name}</div>
              <div className="flex-1 flex relative">
                <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 bg-zinc-400"
                  style={{ height: `${thickness}px` }} />
                {Array.from({ length: FRETS + 1 }).map((_, f) => {
                  const isTarget = sIdx === target.stringIdx && f === target.fret;
                  const note = noteAt(sIdx, f);
                  const noteMatch = highlightNote && note === highlightNote;
                  const color = NOTE_COLORS[note];
                  return (
                    <div key={f} style={{ flex: fretFlex(f) }}
                      className="relative h-7 sm:h-9 flex items-center justify-center">
                      {/* Nut: fret 0 IS the nut — render thick white bar across the fret-0 cell */}
                      {f === 0 && (
                        <div className="absolute inset-y-0 right-0 w-1.5 bg-zinc-100 rounded-sm shadow-[0_0_4px_rgba(255,255,255,0.4)]" />
                      )}
                      {f > 0 && (
                        <div className="absolute right-0 top-0 bottom-0 w-[2px] bg-gradient-to-b from-zinc-300 via-zinc-500 to-zinc-300" />
                      )}

                      {isTarget && (
                        <div className={`relative z-20 w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[10px] font-extrabold ring-2 ${
                          feedback === "correct" ? "bg-emerald-400 text-zinc-900 ring-emerald-200"
                          : feedback === "wrong" ? "bg-rose-500 text-white ring-rose-200"
                          : "bg-amber-400 text-zinc-900 ring-amber-200 animate-pulse"
                        }`}>
                          {hideTargetName ? "" : target.note}
                        </div>
                      )}
                      {!isTarget && noteMatch && (
                        <div className="relative z-20 w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[10px] font-extrabold bg-amber-400 text-zinc-900 ring-2 ring-amber-200">
                          {note}
                        </div>
                      )}
                      {!isTarget && !noteMatch && showAll && (
                        <div className="relative z-20 w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[10px] font-extrabold text-zinc-900"
                          style={{ backgroundColor: color }}>
                          {note}
                        </div>
                      )}
                      {hit && f === 0 && (
                        <div className="absolute left-1 top-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="w-6 sm:w-7 text-center text-sm sm:text-base font-extrabold text-amber-300 font-mono">{s.name}</div>
            </div>
          );
        })}
      </div>
      {FretNumRow}
    </div>
  );
}

/* ───────── Tour overlay with spotlight on data-tour element ───────── */

function TourOverlay({
  step, index, total, onNext, onClose,
}: {
  step: { sel: string; text: string };
  index: number; total: number;
  onNext: () => void; onClose: () => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const update = () => {
      const el = document.querySelector(`[data-tour="${step.sel}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        setRect(el.getBoundingClientRect());
      } else setRect(null);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const id = setInterval(update, 300);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      clearInterval(id);
    };
  }, [step.sel]);

  const pad = 6;
  const hole = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : null;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* 4 dim panels around the hole */}
      {hole ? (
        <>
          <div className="absolute bg-black/75 pointer-events-auto" style={{ top: 0, left: 0, right: 0, height: hole.top }} onClick={onClose} />
          <div className="absolute bg-black/75 pointer-events-auto" style={{ top: hole.top, left: 0, width: hole.left, height: hole.height }} onClick={onClose} />
          <div className="absolute bg-black/75 pointer-events-auto" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} onClick={onClose} />
          <div className="absolute bg-black/75 pointer-events-auto" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} onClick={onClose} />
          <div className="absolute rounded-lg ring-4 ring-amber-400 pointer-events-none animate-pulse"
            style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }} />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/75 pointer-events-auto" onClick={onClose} />
      )}
      <div className="absolute left-1/2 -translate-x-1/2 bottom-4 max-w-md w-[92%] bg-zinc-900 border border-amber-400/50 rounded-2xl p-4 pointer-events-auto shadow-2xl">
        <div className="text-[10px] uppercase tracking-wider text-amber-400 mb-1">Tour · {index + 1}/{total}</div>
        <div className="text-sm text-zinc-100 mb-3">{step.text}</div>
        <div className="flex justify-between">
          <button onClick={onClose} className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs">Skip</button>
          <button onClick={onNext} className="px-3 py-1.5 rounded bg-amber-400 text-zinc-900 font-bold text-xs">
            {index + 1 >= total ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
