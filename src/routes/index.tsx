import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Fretwise — Learn the Guitar Fretboard" },
      { name: "description", content: "Practice guitar note names on the fretboard with real-time mic pitch detection." },
      { property: "og:title", content: "Fretwise — Learn the Guitar Fretboard" },
      { property: "og:description", content: "Practice guitar note names on the fretboard with real-time mic pitch detection." },
    ],
  }),
  component: Index,
});

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Display order: high E (thinnest) on top → low E (thickest) on bottom.
const STRINGS = [
  { name: "E", openMidi: 64 }, // high E (1st)
  { name: "B", openMidi: 59 },
  { name: "G", openMidi: 55 },
  { name: "D", openMidi: 50 },
  { name: "A", openMidi: 45 },
  { name: "E", openMidi: 40 }, // low E (6th)
];
const FRETS = 12;

const midiToName = (m: number) => NOTE_NAMES[((m % 12) + 12) % 12];
const noteAt = (stringIdx: number, fret: number) => midiToName(STRINGS[stringIdx].openMidi + fret);

type Mode = "find-note" | "name-note" | "scale" | "guitar";

type Target = { stringIdx: number; fret: number; note: string };

function randomTarget(allowedStrings: number[], allowedNotes: string[]): Target {
  const strings = allowedStrings.length ? allowedStrings : [0, 1, 2, 3, 4, 5];
  const notes = allowedNotes.length ? allowedNotes : NOTE_NAMES;
  // try random positions until note matches; fallback to brute search
  for (let i = 0; i < 80; i++) {
    const stringIdx = strings[Math.floor(Math.random() * strings.length)];
    const fret = Math.floor(Math.random() * (FRETS + 1));
    const note = noteAt(stringIdx, fret);
    if (notes.includes(note)) return { stringIdx, fret, note };
  }
  const candidates: Target[] = [];
  for (const s of strings) for (let f = 0; f <= FRETS; f++) {
    const n = noteAt(s, f);
    if (notes.includes(n)) candidates.push({ stringIdx: s, fret: f, note: n });
  }
  return candidates[Math.floor(Math.random() * candidates.length)] ?? { stringIdx: 0, fret: 0, note: noteAt(0, 0) };
}

// ---- Pitch detection (autocorrelation) ----
function autoCorrelate(buf: Float32Array, sampleRate: number): number {
  let SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;
  let r1 = 0, r2 = SIZE - 1, thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  buf = buf.slice(r1, r2);
  SIZE = buf.length;
  const c = new Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++)
    for (let j = 0; j < SIZE - i; j++) c[i] += buf[j] * buf[j + i];
  let d = 0;
  while (c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < SIZE; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  let T0 = maxpos;
  if (T0 <= 0) return -1;
  const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);
  return sampleRate / T0;
}

const freqToMidi = (f: number) => Math.round(69 + 12 * Math.log2(f / 440));

function Index() {
  const [mode, setMode] = useState<Mode>("find-note");
  const [allowedStrings, setAllowedStrings] = useState<number[]>([0, 1, 2, 3, 4, 5]);
  const [allowedNotes, setAllowedNotes] = useState<string[]>([...NOTE_NAMES]);
  // Deterministic initial value to avoid SSR/CSR hydration mismatch; randomize after mount.
  const [target, setTarget] = useState<Target>({ stringIdx: 0, fret: 0, note: noteAt(0, 0) });
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [detectedNote, setDetectedNote] = useState<string | null>(null);
  const [detectedFreq, setDetectedFreq] = useState<number | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [feedback, setFeedback] = useState<"idle" | "correct" | "wrong">("idle");
  const [showAll, setShowAll] = useState(false);

  const audioRef = useRef<{ ctx: AudioContext; stream: MediaStream; analyser: AnalyserNode; raf: number } | null>(null);
  const lastCorrectRef = useRef<number>(0);

  const next = () => {
    setTarget(randomTarget(allowedStrings, allowedNotes));
    setFeedback("idle");
  };

  // Randomize after mount to keep SSR HTML stable.
  useEffect(() => {
    setTarget(randomTarget(allowedStrings, allowedNotes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCorrect = () => {
    const now = Date.now();
    if (now - lastCorrectRef.current < 800) return;
    lastCorrectRef.current = now;
    setScore((s) => s + 1);
    setStreak((s) => s + 1);
    setFeedback("correct");
    setTimeout(() => {
      setTarget(randomTarget(allowedStrings, allowedNotes));
      setFeedback("idle");
    }, 600);
  };

  const handleWrong = () => {
    setStreak(0);
    setFeedback("wrong");
    setTimeout(() => setFeedback("idle"), 500);
  };

  // Check detected note against target (mic-driven modes)
  useEffect(() => {
    if (!detectedNote || feedback !== "idle") return;
    if (detectedNote === target.note) handleCorrect();
  }, [detectedNote, target, feedback]);

  // Guitar mode: auto-enable mic when selected, stop when leaving.
  useEffect(() => {
    if (mode === "guitar" && !micOn) startMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function startMic() {
    if (audioRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        const f = autoCorrelate(buf, ctx.sampleRate);
        if (f > 60 && f < 1200) {
          setDetectedFreq(f);
          setDetectedNote(midiToName(freqToMidi(f)));
        } else {
          setDetectedFreq(null);
        }
        audioRef.current!.raf = requestAnimationFrame(tick);
      };
      audioRef.current = { ctx, stream, analyser, raf: requestAnimationFrame(tick) };
      setMicOn(true);
    } catch (e) {
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
    setDetectedNote(null);
    setDetectedFreq(null);
  }

  useEffect(() => () => stopMic(), []);

  const cents = useMemo(() => {
    if (!detectedFreq) return 0;
    const midi = 69 + 12 * Math.log2(detectedFreq / 440);
    return Math.round((midi - Math.round(midi)) * 100);
  }, [detectedFreq]);

  const promptText = useMemo(() => {
    const stringNum = target.stringIdx + 1; // 1 = high E (top)
    if (mode === "find-note") return `Play ${target.note} — string ${stringNum} (${STRINGS[target.stringIdx].name}), fret ${target.fret}`;
    if (mode === "name-note") return `What note is this?`;
    if (mode === "guitar") return `🎸 Play ${target.note} on string ${stringNum} (${STRINGS[target.stringIdx].name}), fret ${target.fret}`;
    return `Play any ${target.note} on the fretboard`;
  }, [mode, target]);

  const toggleString = (i: number) =>
    setAllowedStrings((cur) => {
      const has = cur.includes(i);
      const nxt = has ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b);
      return nxt.length ? nxt : cur; // never allow zero
    });
  const toggleNote = (n: string) =>
    setAllowedNotes((cur) => {
      const has = cur.includes(n);
      const nxt = has ? cur.filter((x) => x !== n) : [...cur, n];
      return nxt.length ? nxt : cur;
    });

  return (
    <div className="min-h-screen bg-[#0e0e12] text-zinc-100">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
        <header className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Fret<span className="text-amber-400">wise</span>
            </h1>
            <p className="text-sm text-zinc-400">Learn the fretboard. Play. Hear yourself improve.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-xs text-zinc-500 uppercase tracking-wider">Score</div>
              <div className="text-xl font-mono">{score} <span className="text-zinc-500 text-sm">· streak {streak}</span></div>
            </div>
          </div>
        </header>

        {/* Mode tabs */}
        <div className="flex flex-wrap gap-2 mb-4">
          {([
            ["find-note", "Find the Note"],
            ["name-note", "Name the Note"],
            ["scale", "Free Play"],
            ["guitar", "Guitar Mode 🎸"],
          ] as [Mode, string][]).map(([m, label]) => (
            <button
              key={m}
              onClick={() => { setMode(m); next(); setScore(0); setStreak(0); }}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${mode === m ? "bg-amber-400 text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
            >{label}</button>
          ))}
          <button
            onClick={() => setShowAll((s) => !s)}
            className="ml-auto px-3 py-1.5 rounded-full text-sm bg-zinc-800 hover:bg-zinc-700"
          >{showAll ? "Hide note names" : "Show all notes"}</button>
        </div>

        {/* Practice filters */}
        <div className="grid sm:grid-cols-2 gap-3 mb-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Strings to practice</div>
            <div className="flex flex-wrap gap-1.5">
              {STRINGS.map((s, i) => {
                const on = allowedStrings.includes(i);
                return (
                  <button
                    key={i}
                    onClick={() => toggleString(i)}
                    className={`px-2.5 py-1 rounded-md text-xs font-mono border ${on ? "bg-amber-400 text-zinc-900 border-amber-400" : "bg-zinc-800/60 text-zinc-500 border-zinc-700 opacity-60"}`}
                  >{i + 1} · {s.name}</button>
                );
              })}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Notes to focus on</div>
            <div className="flex flex-wrap gap-1.5">
              {NOTE_NAMES.map((n) => {
                const on = allowedNotes.includes(n);
                return (
                  <button
                    key={n}
                    onClick={() => toggleNote(n)}
                    className={`px-2 py-1 rounded-md text-xs font-mono border ${on ? "bg-amber-400 text-zinc-900 border-amber-400" : "bg-zinc-800/60 text-zinc-500 border-zinc-700 opacity-60"}`}
                  >{n}</button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Prompt */}
        <div className={`rounded-2xl p-5 mb-5 border transition-colors ${feedback === "correct" ? "bg-emerald-500/10 border-emerald-500/40" : feedback === "wrong" ? "bg-rose-500/10 border-rose-500/40" : "bg-zinc-900/60 border-zinc-800"}`}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Challenge</div>
              <div className="text-lg sm:text-xl font-semibold">{promptText}</div>
            </div>
            <div className="flex items-center gap-2">
              {mode === "name-note" && (
                <div className="flex gap-1 flex-wrap max-w-md justify-end">
                  {NOTE_NAMES.map((n) => (
                    <button
                      key={n}
                      onClick={() => (n === target.note ? handleCorrect() : handleWrong())}
                      className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-amber-400 hover:text-zinc-900 text-sm font-mono"
                    >{n}</button>
                  ))}
                </div>
              )}
              <button onClick={next} className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-sm">Skip ›</button>
            </div>
          </div>
        </div>

        {/* Fretboard */}
        <Fretboard
          target={target}
          showAll={showAll}
          highlightNote={mode === "scale" ? target.note : null}
          feedback={feedback}
          allowedStrings={allowedStrings}
        />

        {/* Mic panel */}
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Mic input</div>
              <div className="flex items-baseline gap-3">
                <div className="text-4xl font-mono font-bold tabular-nums">
                  {detectedNote ?? "—"}
                </div>
                <div className="text-sm text-zinc-400">
                  {detectedFreq ? `${detectedFreq.toFixed(1)} Hz` : "listening for a note…"}
                </div>
              </div>
              {detectedFreq && (
                <div className="mt-2 w-64 h-2 bg-zinc-800 rounded-full overflow-hidden relative">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-600" />
                  <div
                    className={`absolute top-0 bottom-0 ${Math.abs(cents) < 10 ? "bg-emerald-400" : "bg-amber-400"}`}
                    style={{ left: "50%", width: `${Math.min(Math.abs(cents), 50)}%`, transform: cents < 0 ? "translateX(-100%)" : "none" }}
                  />
                </div>
              )}
            </div>
            <button
              onClick={micOn ? stopMic : startMic}
              className={`px-4 py-2 rounded-lg font-semibold ${micOn ? "bg-rose-500 hover:bg-rose-600 text-white" : "bg-amber-400 hover:bg-amber-300 text-zinc-900"}`}
            >{micOn ? "Stop mic" : "Enable mic"}</button>
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            Tip: play a clean, single note close to your mic. Detection only checks the note name (octave-independent), so any E counts as E.
          </p>
        </div>

        <footer className="mt-8 text-center text-xs text-zinc-600">
          Standard tuning · EADGBE · Built for ears and fingers.
        </footer>
      </div>
    </div>
  );
}

function Fretboard({
  target,
  showAll,
  highlightNote,
  feedback,
}: {
  target: Target;
  showAll: boolean;
  highlightNote: string | null;
  feedback: "idle" | "correct" | "wrong";
}) {
  const inlayFrets = [3, 5, 7, 9, 12];
  return (
    <div className="rounded-2xl border border-zinc-800 bg-gradient-to-b from-[#1a140d] to-[#0f0b07] p-3 sm:p-5 overflow-x-auto">
      <div className="min-w-[820px]">
        {/* Fret numbers */}
        <div className="flex pl-10 mb-2">
          {Array.from({ length: FRETS + 1 }).map((_, f) => (
            <div key={f} className="flex-1 text-center text-[10px] text-zinc-500 font-mono">{f}</div>
          ))}
        </div>

        {STRINGS.map((s, sIdx) => (
          <div key={sIdx} className="flex items-center h-10">
            <div className="w-10 text-right pr-3 text-sm font-mono text-zinc-400">{s.name}</div>
            <div className="flex-1 flex relative">
              {/* string line */}
              <div
                className="absolute left-0 right-0 top-1/2 -translate-y-1/2 bg-zinc-500/70"
                style={{ height: `${Math.max(1, (6 - sIdx) * 0.6)}px` }}
              />
              {Array.from({ length: FRETS + 1 }).map((_, f) => {
                const isTarget = sIdx === target.stringIdx && f === target.fret;
                const note = noteAt(sIdx, f);
                const noteMatch = highlightNote && note === highlightNote;
                return (
                  <div key={f} className="flex-1 relative h-10 flex items-center justify-center">
                    {/* fret wire */}
                    {f > 0 && (
                      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-gradient-to-b from-zinc-300 via-zinc-500 to-zinc-300" />
                    )}
                    {f === 0 && (
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-zinc-100" />
                    )}
                    {/* inlay dot (between frets visually shown in the slot of that fret) */}
                    {sIdx === 2 && inlayFrets.includes(f) && (
                      <div className={`absolute inset-0 flex items-center justify-center pointer-events-none`}>
                        {f === 12 ? (
                          <div className="flex flex-col gap-3">
                            <div className="w-2 h-2 rounded-full bg-zinc-700" />
                            <div className="w-2 h-2 rounded-full bg-zinc-700" />
                          </div>
                        ) : (
                          <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                        )}
                      </div>
                    )}

                    {isTarget && (
                      <div className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ring-2 ${
                        feedback === "correct" ? "bg-emerald-400 text-zinc-900 ring-emerald-200 animate-pulse" :
                        feedback === "wrong" ? "bg-rose-500 text-white ring-rose-200" :
                        "bg-amber-400 text-zinc-900 ring-amber-200 animate-pulse"
                      }`}>
                        {target.note}
                      </div>
                    )}
                    {!isTarget && noteMatch && (
                      <div className="relative z-10 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold bg-sky-400/90 text-zinc-900">
                        {note}
                      </div>
                    )}
                    {!isTarget && !noteMatch && showAll && (
                      <div className="relative z-10 text-[10px] font-mono text-zinc-300/70 bg-zinc-900/60 rounded px-1">
                        {note}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
