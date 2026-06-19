import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Fretwise — Learn the Guitar Fretboard" },
      {
        name: "description",
        content:
          "Practice guitar notes with mic pitch detection, tuner, tolerance control and a guided tour.",
      },
    ],
  }),
  component: Index,
});

/* ───────────────────────── Music helpers ───────────────────────── */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Display order: high E (thinnest) on top → low E (thickest) on bottom.
const STRINGS = [
  { name: "E", openMidi: 64 }, // 1 high E
  { name: "B", openMidi: 59 },
  { name: "G", openMidi: 55 },
  { name: "D", openMidi: 50 },
  { name: "A", openMidi: 45 },
  { name: "E", openMidi: 40 }, // 6 low E
];
const FRETS = 12;

const midiToName = (m: number) => NOTE_NAMES[((m % 12) + 12) % 12];
const midiToOctave = (m: number) => Math.floor(m / 12) - 1;
const midiAt = (s: number, f: number) => STRINGS[s].openMidi + f;
const noteAt = (s: number, f: number) => midiToName(midiAt(s, f));
const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const freqToMidiFloat = (f: number) => 69 + 12 * Math.log2(f / 440);

const NOTE_COLORS: Record<string, string> = {
  C: "#ef4444",
  "C#": "#f97316",
  D: "#f59e0b",
  "D#": "#eab308",
  E: "#84cc16",
  F: "#22c55e",
  "F#": "#14b8a6",
  G: "#06b6d4",
  "G#": "#3b82f6",
  A: "#8b5cf6",
  "A#": "#d946ef",
  B: "#ec4899",
};

type Mode = "find-note" | "name-note" | "guitar" | "all-strings" | "scale";
type Feedback = "idle" | "correct" | "wrong";
type Target = { stringIdx: number; fret: number; note: string; midi: number };

function randomTarget(allowedStrings: number[], allowedNotes: string[]): Target {
  const strings = allowedStrings.length ? allowedStrings : [0, 1, 2, 3, 4, 5];
  const notes = allowedNotes.length ? allowedNotes : NOTE_NAMES;
  const candidates: Target[] = [];
  for (const s of strings)
    for (let f = 0; f <= FRETS; f++) {
      const n = noteAt(s, f);
      if (notes.includes(n))
        candidates.push({ stringIdx: s, fret: f, note: n, midi: midiAt(s, f) });
    }
  if (!candidates.length) return { stringIdx: 0, fret: 0, note: noteAt(0, 0), midi: midiAt(0, 0) };
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function pickChoices(correct: string, n = 4): string[] {
  const pool = NOTE_NAMES.filter((x) => x !== correct);
  const picks = new Set<string>();
  while (picks.size < n - 1) picks.add(pool[Math.floor(Math.random() * pool.length)]);
  const arr = [correct, ...picks];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ───────────────────────── Pitch detection ───────────────────────── */

function autoCorrelate(buf: Float32Array, sampleRate: number): number {
  let SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;
  let r1 = 0,
    r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++)
    if (Math.abs(buf[i]) < thres) {
      r1 = i;
      break;
    }
  for (let i = 1; i < SIZE / 2; i++)
    if (Math.abs(buf[SIZE - i]) < thres) {
      r2 = SIZE - i;
      break;
    }
  buf = buf.slice(r1, r2);
  SIZE = buf.length;
  const c = new Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) for (let j = 0; j < SIZE - i; j++) c[i] += buf[j] * buf[j + i];
  let d = 0;
  while (c[d] > c[d + 1]) d++;
  let maxval = -1,
    maxpos = -1;
  for (let i = d; i < SIZE; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }
  let T0 = maxpos;
  if (T0 <= 0) return -1;
  const x1 = c[T0 - 1],
    x2 = c[T0],
    x3 = c[T0 + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);
  return sampleRate / T0;
}

/* ───────────────────────── Audio feedback ───────────────────────── */

let fxCtx: AudioContext | null = null;
function ensureFx() {
  if (typeof window === "undefined") return null;
  if (!fxCtx) fxCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return fxCtx;
}
function playTone(kind: "correct" | "wrong" | "tick", enabled: boolean) {
  if (!enabled) return;
  const ctx = ensureFx();
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.connect(g);
  g.connect(ctx.destination);
  if (kind === "correct") {
    o.type = "sine";
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start(t);
    o.stop(t + 0.3);
  } else if (kind === "wrong") {
    o.type = "square";
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.start(t);
    o.stop(t + 0.22);
  } else {
    o.type = "triangle";
    o.frequency.setValueAtTime(660, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.start(t);
    o.stop(t + 0.1);
  }
}

/* ───────────────────────── Component ───────────────────────── */

type CellKey = string; // `${stringIdx}:${fret}`
type CellStat = { attempts: number; correct: number };

function Index() {
  const [mode, setMode] = useState<Mode>("find-note");
  const [allowedStrings, setAllowedStrings] = useState<number[]>([0, 1, 2, 3, 4, 5]);
  const [allowedNotes, setAllowedNotes] = useState<string[]>([...NOTE_NAMES]);
  const [target, setTarget] = useState<Target>({
    stringIdx: 0,
    fret: 0,
    note: noteAt(0, 0),
    midi: midiAt(0, 0),
  });
  const [choices, setChoices] = useState<string[]>(() => pickChoices(noteAt(0, 0)));

  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [perCell, setPerCell] = useState<Record<CellKey, CellStat>>({});
  const [completed, setCompleted] = useState<Set<CellKey>>(new Set());

  const [detectedFreq, setDetectedFreq] = useState<number | null>(null);
  const [detectedMidi, setDetectedMidi] = useState<number | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>("idle");
  const [showAll, setShowAll] = useState(false);

  const [tolerance, setTolerance] = useState(25); // cents
  const [soundOn, setSoundOn] = useState(true);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [isFs, setIsFs] = useState(false);

  // All-strings mode: which strings the user has already played the target note on
  const [stringsHit, setStringsHit] = useState<Set<number>>(new Set());

  // Tour
  const [tourStep, setTourStep] = useState(-1);

  const audioRef = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    analyser: AnalyserNode;
    raf: number;
  } | null>(null);
  const lastCorrectRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const targetRef = useRef(target);
  targetRef.current = target;

  /* ── Lifecycle ── */

  useEffect(() => {
    nextTarget();
    try {
      if (!localStorage.getItem("fretwise.tour")) setTourStep(0);
    } catch {}
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

  /* ── Game flow ── */

  const nextTarget = useCallback(() => {
    const t = randomTarget(allowedStrings, allowedNotes);
    setTarget(t);
    setChoices(pickChoices(t.note));
    setStringsHit(new Set());
    setFeedback("idle");
  }, [allowedStrings, allowedNotes]);

  const cellKey = (s: number, f: number): CellKey => `${s}:${f}`;

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
    setStreak((s) => {
      const n = s + 1;
      setBestStreak((b) => Math.max(b, n));
      return n;
    });
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

  /* ── Per-string accuracy aggregates ── */

  const stringAcc = useMemo(() => {
    const out: Record<number, CellStat> = {};
    for (const k in perCell) {
      const s = Number(k.split(":")[0]);
      const c = perCell[k];
      out[s] = out[s] || { attempts: 0, correct: 0 };
      out[s].attempts += c.attempts;
      out[s].correct += c.correct;
    }
    return out;
  }, [perCell]);

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
        if (f > 60 && f < 1400) {
          setDetectedFreq(f);
          setDetectedMidi(freqToMidiFloat(f));
        } else {
          setDetectedFreq(null);
          setDetectedMidi(null);
        }
        audioRef.current!.raf = requestAnimationFrame(tick);
      };
      audioRef.current = { ctx, stream, analyser, raf: requestAnimationFrame(tick) };
      setMicOn(true);
    } catch {
      alert("Microphone permission denied or unavailable.");
    }
  }
  function stopMic() {
    if (!audioRef.current) return;
    cancelAnimationFrame(audioRef.current.raf);
    audioRef.current.stream.getTracks().forEach((t) => t.stop());
    audioRef.current.ctx.close();
    audioRef.current = null;
    setMicOn(false);
    setDetectedFreq(null);
    setDetectedMidi(null);
  }

  /* ── Mic-driven answering (octave-dependent + tolerance) ── */

  useEffect(() => {
    if (!detectedMidi || feedback !== "idle") return;
    if (mode !== "find-note" && mode !== "guitar" && mode !== "all-strings") return;

    if (mode === "all-strings") {
      // Match by note name on each selected string; require correct string by octave detection
      // Find which selected string's open MIDI + fret in [0,12] best matches detectedMidi & target note
      for (const s of allowedStrings) {
        if (stringsHit.has(s)) continue;
        for (let f = 0; f <= FRETS; f++) {
          if (noteAt(s, f) !== target.note) continue;
          const exact = midiAt(s, f);
          const cents = (detectedMidi - exact) * 100;
          if (Math.abs(cents) <= tolerance) {
            const newHits = new Set(stringsHit).add(s);
            setStringsHit(newHits);
            playTone("tick", soundOn);
            recordAttempt(s, f, true);
            setCompleted((c) => new Set(c).add(cellKey(s, f)));
            if (newHits.size === allowedStrings.length) {
              setScore((x) => x + 1);
              setStreak((s) => {
                const n = s + 1;
                setBestStreak((b) => Math.max(b, n));
                return n;
              });
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

    // find-note / guitar: exact MIDI ± tolerance
    const cents = (detectedMidi - target.midi) * 100;
    if (Math.abs(cents) <= tolerance) handleCorrect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedMidi, target, feedback, mode, tolerance, allowedStrings, stringsHit]);

  /* ── Tuner: nearest open string ── */
  const tunerInfo = useMemo(() => {
    if (!detectedMidi) return null;
    let best = STRINGS[0],
      bestIdx = 0,
      bestDiff = Infinity;
    STRINGS.forEach((s, i) => {
      const d = Math.abs(detectedMidi - s.openMidi);
      if (d < bestDiff) {
        bestDiff = d;
        best = s;
        bestIdx = i;
      }
    });
    const cents = (detectedMidi - best.openMidi) * 100;
    return { string: best, idx: bestIdx, cents };
  }, [detectedMidi]);

  /* ── Cents to current target for the meter ── */
  const centsToTarget = useMemo(() => {
    if (!detectedMidi) return 0;
    if (mode === "find-note" || mode === "guitar") return (detectedMidi - target.midi) * 100;
    if (!detectedFreq) return 0;
    const nearest = Math.round(detectedMidi);
    return (detectedMidi - nearest) * 100;
  }, [detectedMidi, detectedFreq, mode, target]);

  /* ── Fullscreen ── */
  const toggleFs = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {}
  };

  /* ── Filter toggles ── */
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
  const TOUR = [
    "Pick a mode here. Find the Note, Name the Note, Guitar, All Strings or Free Play.",
    "Limit which strings and notes you practice. Per-box numbers show your accuracy.",
    "Open the tuner before each session to tune your guitar.",
    "Pitch tolerance: how many cents off counts as correct.",
    "The fretboard. Target dot glows. In Find/Guitar/All-Strings the name is hidden — pick from 4 choices below.",
    "Session progress tracks accuracy, streak and coverage of your selected scope.",
    "Enable mic, toggle sound and go fullscreen from the header.",
    "Click Tour anytime to see this again.",
  ];
  const closeTour = () => {
    setTourStep(-1);
    try {
      localStorage.setItem("fretwise.tour", "1");
    } catch {}
  };

  /* ── Prompt text ── */
  const promptText = useMemo(() => {
    const sNum = target.stringIdx + 1;
    const sName = STRINGS[target.stringIdx].name;
    if (mode === "find-note")
      return `Play ${target.note}${midiToOctave(target.midi)} on string ${sNum} (${sName}) fret ${target.fret}`;
    if (mode === "guitar")
      return `🎸 Play ${target.note}${midiToOctave(target.midi)} — string ${sNum} (${sName}) fret ${target.fret}`;
    if (mode === "name-note") return "What note is highlighted?";
    if (mode === "all-strings")
      return `Play ${target.note} on every selected string (${stringsHit.size}/${allowedStrings.length})`;
    return `Free play — find ${target.note} anywhere`;
  }, [mode, target, stringsHit, allowedStrings]);

  const hideNoteOnBoard = mode === "find-note" || mode === "guitar" || mode === "name-note";

  /* ───── Render ───── */
  return (
    <div
      ref={rootRef}
      className="min-h-[100dvh] bg-[#0e0e12] text-zinc-100 overflow-x-hidden"
    >
      <div className="mx-auto max-w-6xl px-3 sm:px-4 py-3 sm:py-6 space-y-3">
        {/* HEADER */}
        <header className="flex items-center justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-3xl font-extrabold tracking-tight">
              Fret<span className="text-amber-400">wise</span>
            </h1>
            <p className="text-[11px] sm:text-sm text-zinc-400 hidden sm:block">
              Learn the fretboard. Play. Hear yourself improve.
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <Stat label="Score" value={score} />
            <Stat label="Streak" value={streak} />
            <Stat label="Acc" value={`${accuracy}%`} />
            <IconBtn onClick={() => setSoundOn((s) => !s)} title="Sound">
              {soundOn ? "🔊" : "🔇"}
            </IconBtn>
            <IconBtn onClick={toggleFs} title="Fullscreen">
              {isFs ? "🗗" : "⛶"}
            </IconBtn>
            <IconBtn onClick={() => setTourStep(0)} title="Tour">
              ?
            </IconBtn>
          </div>
        </header>

        {/* MODE TABS */}
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["find-note", "Find the Note"],
              ["name-note", "Name the Note"],
              ["guitar", "Guitar 🎸"],
              ["all-strings", "All Strings"],
              ["scale", "Free Play"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                nextTarget();
              }}
              className={`px-2.5 sm:px-3 py-1.5 rounded-full text-xs sm:text-sm font-semibold transition ${
                mode === m
                  ? "bg-amber-400 text-zinc-900"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setShowAll((s) => !s)}
            className="ml-auto px-2.5 py-1.5 rounded-full text-xs sm:text-sm bg-zinc-800 hover:bg-zinc-700"
          >
            {showAll ? "Hide notes" : "Show all notes"}
          </button>
        </div>

        {/* TUNER + TOLERANCE */}
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wider text-zinc-500">Tuner</div>
              <button
                onClick={() => {
                  setTunerOpen((o) => !o);
                  if (!micOn) startMic();
                }}
                className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
              >
                {tunerOpen ? "Hide" : "Open"}
              </button>
            </div>
            {tunerOpen ? (
              <Tuner info={tunerInfo} freq={detectedFreq} />
            ) : (
              <div className="text-[11px] text-zinc-500">Tap Open to tune your guitar.</div>
            )}
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                Pitch tolerance
              </div>
              <div className="text-xs font-mono text-amber-400">±{tolerance}¢</div>
            </div>
            <input
              type="range"
              min={5}
              max={50}
              step={1}
              value={tolerance}
              onChange={(e) => setTolerance(Number(e.target.value))}
              className="w-full accent-amber-400"
            />
            <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
              <span>Strict 5¢</span>
              <span>Loose 50¢</span>
            </div>
          </div>
        </div>

        {/* PRACTICE FILTERS */}
        <div className="grid sm:grid-cols-2 gap-3">
          <Panel title="Strings to practice">
            <div className="grid grid-cols-4 gap-1.5">
              {STRINGS.map((s, i) => {
                const on = allowedStrings.includes(i);
                const st = stringAcc[i];
                const pct = st && st.attempts ? Math.round((st.correct / st.attempts) * 100) : null;
                return (
                  <button
                    key={i}
                    onClick={() => toggleString(i)}
                    className={`px-2 py-2 rounded-md border font-bold text-sm transition ${
                      on
                        ? "bg-amber-400 text-zinc-900 border-amber-400"
                        : "bg-zinc-800/60 text-zinc-500 border-zinc-700 opacity-50"
                    }`}
                  >
                    <div className="text-base leading-none">
                      {i + 1} · {s.name}
                    </div>
                    {pct !== null && (
                      <div className="text-[10px] mt-0.5 font-mono opacity-80">{pct}%</div>
                    )}
                  </button>
                );
              })}
            </div>
          </Panel>
          <Panel title="Notes to focus on">
            <div className="grid grid-cols-6 gap-1.5">
              {NOTE_NAMES.map((n) => {
                const on = allowedNotes.includes(n);
                const st = noteAcc[n];
                const pct = st && st.attempts ? Math.round((st.correct / st.attempts) * 100) : null;
                return (
                  <button
                    key={n}
                    onClick={() => toggleNote(n)}
                    className={`px-1 py-2 rounded-md border font-bold text-sm transition ${
                      on
                        ? "bg-amber-400 text-zinc-900 border-amber-400"
                        : "bg-zinc-800/60 text-zinc-500 border-zinc-700 opacity-50"
                    }`}
                  >
                    <div className="text-base leading-none font-mono">{n}</div>
                    {pct !== null && (
                      <div className="text-[10px] mt-0.5 font-mono opacity-80">{pct}%</div>
                    )}
                  </button>
                );
              })}
            </div>
          </Panel>
        </div>

        {/* PROMPT */}
        <div
          className={`rounded-2xl p-4 border transition-colors ${
            feedback === "correct"
              ? "bg-emerald-500/10 border-emerald-500/40"
              : feedback === "wrong"
                ? "bg-rose-500/10 border-rose-500/40"
                : "bg-zinc-900/60 border-zinc-800"
          }`}
        >
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">
                Challenge
              </div>
              <div className="text-base sm:text-xl font-bold">{promptText}</div>
              {mode === "all-strings" && (
                <div className="mt-2 flex gap-1.5">
                  {allowedStrings.map((s) => (
                    <span
                      key={s}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                        stringsHit.has(s)
                          ? "bg-emerald-500 text-zinc-900"
                          : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {s + 1}·{STRINGS[s].name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={nextTarget}
              className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-sm"
            >
              Skip ›
            </button>
          </div>
        </div>

        {/* FRETBOARD */}
        <Fretboard
          target={target}
          showAll={showAll}
          hideTargetName={hideNoteOnBoard}
          highlightNote={mode === "scale" ? target.note : null}
          feedback={feedback}
          allowedStrings={allowedStrings}
          stringsHit={mode === "all-strings" ? stringsHit : null}
        />

        {/* ANSWER CHOICES (find-note, name-note, guitar) */}
        {(mode === "find-note" || mode === "name-note" || mode === "guitar") && (
          <div className="grid grid-cols-4 gap-2">
            {choices.map((n) => (
              <button
                key={n}
                onClick={() => (n === target.note ? handleCorrect() : handleWrong())}
                className="px-2 py-3 rounded-xl bg-zinc-800 hover:bg-amber-400 hover:text-zinc-900 text-lg font-extrabold font-mono"
                style={{ borderTop: `3px solid ${NOTE_COLORS[n]}` }}
              >
                {n}
              </button>
            ))}
          </div>
        )}

        {/* SESSION PROGRESS */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Session progress
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <Mini label="Accuracy" value={`${accuracy}%`} />
            <Mini label="Attempts" value={attempts} />
            <Mini label="Streak" value={`${streak} / ${bestStreak}`} />
            <Mini
              label="Coverage"
              value={`${completedInScope}/${totalPositions}`}
            />
          </div>
          <div className="mt-2 h-2 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-amber-400 transition-all"
              style={{
                width: `${totalPositions ? (completedInScope / totalPositions) * 100 : 0}%`,
              }}
            />
          </div>
        </div>

        {/* MIC PANEL */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">
                Mic input
              </div>
              <div className="flex items-baseline gap-3">
                <div className="text-3xl font-mono font-extrabold tabular-nums">
                  {detectedMidi !== null
                    ? `${midiToName(Math.round(detectedMidi))}${midiToOctave(Math.round(detectedMidi))}`
                    : "—"}
                </div>
                <div className="text-xs text-zinc-400">
                  {detectedFreq ? `${detectedFreq.toFixed(1)} Hz` : "listening…"}
                </div>
              </div>
              {detectedFreq && (
                <div className="mt-2 w-56 h-2 bg-zinc-800 rounded-full overflow-hidden relative">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-500" />
                  <div
                    className={`absolute top-0 bottom-0 ${
                      Math.abs(centsToTarget) < 10 ? "bg-emerald-400" : "bg-amber-400"
                    }`}
                    style={{
                      left: "50%",
                      width: `${Math.min(Math.abs(centsToTarget), 50)}%`,
                      transform: centsToTarget < 0 ? "translateX(-100%)" : "none",
                    }}
                  />
                </div>
              )}
            </div>
            <button
              onClick={micOn ? stopMic : startMic}
              className={`px-4 py-2 rounded-lg font-bold ${
                micOn
                  ? "bg-rose-500 hover:bg-rose-600 text-white"
                  : "bg-amber-400 hover:bg-amber-300 text-zinc-900"
              }`}
            >
              {micOn ? "Stop mic" : "Enable mic"}
            </button>
          </div>
        </div>

        <footer className="text-center text-[10px] text-zinc-600 pt-1">
          Standard tuning · EADGBE
        </footer>
      </div>

      {/* TOUR OVERLAY */}
      {tourStep >= 0 && tourStep < TOUR.length && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-amber-400/40 rounded-2xl p-5 max-w-md w-full">
            <div className="text-xs uppercase tracking-wider text-amber-400 mb-2">
              Tour · {tourStep + 1} / {TOUR.length}
            </div>
            <div className="text-base text-zinc-100 mb-4">{TOUR[tourStep]}</div>
            <div className="flex justify-between">
              <button
                onClick={closeTour}
                className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-sm"
              >
                Skip
              </button>
              <button
                onClick={() =>
                  tourStep + 1 >= TOUR.length ? closeTour() : setTourStep(tourStep + 1)
                }
                className="px-3 py-1.5 rounded bg-amber-400 text-zinc-900 font-bold text-sm"
              >
                {tourStep + 1 >= TOUR.length ? "Done" : "Next"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Subcomponents ───────────────────────── */

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="px-2 py-1 rounded bg-zinc-900/70 border border-zinc-800 text-right">
      <div className="text-[9px] uppercase text-zinc-500 leading-none">{label}</div>
      <div className="text-sm font-mono font-bold">{value}</div>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-9 h-9 rounded-md bg-zinc-800 hover:bg-zinc-700 text-base flex items-center justify-center"
    >
      {children}
    </button>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">{title}</div>
      {children}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-zinc-950/50 border border-zinc-800 py-2">
      <div className="text-[10px] uppercase text-zinc-500">{label}</div>
      <div className="text-lg font-mono font-bold">{value}</div>
    </div>
  );
}

function Tuner({
  info,
  freq,
}: {
  info: { string: { name: string; openMidi: number }; idx: number; cents: number } | null;
  freq: number | null;
}) {
  return (
    <div>
      <div className="flex gap-1 mb-2">
        {STRINGS.map((s, i) => (
          <div
            key={i}
            className={`flex-1 text-center py-1.5 rounded text-sm font-bold ${
              info && info.idx === i && Math.abs(info.cents) < 10
                ? "bg-emerald-400 text-zinc-900"
                : info && info.idx === i
                  ? "bg-amber-400 text-zinc-900"
                  : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {s.name}
          </div>
        ))}
      </div>
      <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-500" />
        {info && (
          <div
            className={`absolute top-0 bottom-0 ${
              Math.abs(info.cents) < 10 ? "bg-emerald-400" : "bg-amber-400"
            }`}
            style={{
              left: "50%",
              width: `${Math.min(Math.abs(info.cents), 50)}%`,
              transform: info.cents < 0 ? "translateX(-100%)" : "none",
            }}
          />
        )}
      </div>
      <div className="mt-1 text-[11px] text-zinc-400 font-mono">
        {info
          ? `${info.string.name}  ${info.cents > 0 ? "+" : ""}${info.cents.toFixed(0)}¢  · ${freq?.toFixed(1)} Hz`
          : "Play an open string…"}
      </div>
    </div>
  );
}

function Fretboard({
  target,
  showAll,
  hideTargetName,
  highlightNote,
  feedback,
  allowedStrings,
  stringsHit,
}: {
  target: Target;
  showAll: boolean;
  hideTargetName: boolean;
  highlightNote: string | null;
  feedback: Feedback;
  allowedStrings: number[];
  stringsHit: Set<number> | null;
}) {
  const inlayFrets = [3, 5, 7, 9, 12];
  const FretNumRow = (
    <div className="flex">
      <div className="w-7 sm:w-9" />
      {Array.from({ length: FRETS + 1 }).map((_, f) => (
        <div
          key={f}
          className="flex-1 text-center text-[10px] sm:text-xs text-amber-300/80 font-bold font-mono"
        >
          {f}
        </div>
      ))}
      <div className="w-7 sm:w-9" />
    </div>
  );

  return (
    <div className="rounded-2xl border border-zinc-800 bg-gradient-to-b from-[#2a1d10] to-[#0f0b07] p-2 sm:p-4 overflow-hidden">
      {FretNumRow}
      <div className="w-full">
        {STRINGS.map((s, sIdx) => {
          const muted = !allowedStrings.includes(sIdx);
          const hit = stringsHit && stringsHit.has(sIdx);
          const thickness = Math.max(1, (sIdx + 1) * 0.7);
          return (
            <div
              key={sIdx}
              className={`flex items-center h-8 sm:h-10 transition-opacity ${
                muted ? "opacity-25" : "opacity-100"
              }`}
            >
              <div className="w-7 sm:w-9 text-center text-base sm:text-lg font-extrabold text-amber-300 font-mono">
                {s.name}
              </div>
              <div className="flex-1 flex relative">
                <div
                  className="absolute left-0 right-0 top-1/2 -translate-y-1/2 bg-zinc-400"
                  style={{ height: `${thickness}px` }}
                />
                {Array.from({ length: FRETS + 1 }).map((_, f) => {
                  const isTarget = sIdx === target.stringIdx && f === target.fret;
                  const note = noteAt(sIdx, f);
                  const noteMatch = highlightNote && note === highlightNote;
                  const color = NOTE_COLORS[note];
                  return (
                    <div
                      key={f}
                      className="flex-1 relative h-8 sm:h-10 flex items-center justify-center"
                    >
                      {/* nut (fret 0) — thick light bar at LEFT edge of fret 0 cell */}
                      {f === 0 && (
                        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-zinc-100 rounded-sm" />
                      )}
                      {/* metal frets at right edge of each numbered fret */}
                      {f > 0 && (
                        <div className="absolute right-0 top-0 bottom-0 w-[2px] bg-gradient-to-b from-zinc-300 via-zinc-500 to-zinc-300" />
                      )}
                      {/* golden inlay markers */}
                      {sIdx === 2 && inlayFrets.includes(f) && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          {f === 12 ? (
                            <div className="flex flex-col gap-2">
                              <div className="w-2.5 h-2.5 rounded-full bg-amber-400 shadow-[0_0_6px_#d4af37]" />
                              <div className="w-2.5 h-2.5 rounded-full bg-amber-400 shadow-[0_0_6px_#d4af37]" />
                            </div>
                          ) : (
                            <div className="w-3 h-3 rounded-full bg-amber-400 shadow-[0_0_6px_#d4af37]" />
                          )}
                        </div>
                      )}

                      {isTarget && (
                        <div
                          className={`relative z-10 w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-xs font-extrabold ring-2 ${
                            feedback === "correct"
                              ? "bg-emerald-400 text-zinc-900 ring-emerald-200"
                              : feedback === "wrong"
                                ? "bg-rose-500 text-white ring-rose-200"
                                : "bg-amber-400 text-zinc-900 ring-amber-200 animate-pulse"
                          }`}
                        >
                          {hideTargetName ? "" : target.note}
                        </div>
                      )}
                      {!isTarget && noteMatch && (
                        <div className="relative z-10 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold bg-sky-400/90 text-zinc-900">
                          {note}
                        </div>
                      )}
                      {!isTarget && !noteMatch && showAll && (
                        <div
                          className="relative z-10 w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-xs font-extrabold text-zinc-900"
                          style={{ backgroundColor: color }}
                        >
                          {note}
                        </div>
                      )}
                      {hit && f === 0 && (
                        <div className="absolute left-2 top-1 w-2 h-2 rounded-full bg-emerald-400" />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="w-7 sm:w-9 text-center text-base sm:text-lg font-extrabold text-amber-300 font-mono">
                {s.name}
              </div>
            </div>
          );
        })}
      </div>
      {FretNumRow}
    </div>
  );
}