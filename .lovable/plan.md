
# Fretwise v2 — Plan

All work stays in `src/routes/index.tsx` plus a couple of small helper files. No backend changes.

## 1. Scoreboard & session progress
- Header score block adds **Accuracy %** (correct / attempts).
- New **Session Progress panel** under the prompt:
  - Streak, best streak, accuracy %, attempts.
  - "Coverage": % of (selectedStrings × selectedNotes) positions completed this session, with a progress bar.
- Per-item accuracy: each string button and each note button shows a tiny % badge of its correct-rate in this session. Boxes tint green→amber→red by accuracy.

## 2. Pitch tolerance slider
- Slider (±5¢ to ±50¢, default ±25¢) controlling how close detected pitch must be to the target note's exact frequency to count as correct.
- Used in `find-note`, `guitar`, and the new `all-strings` mode. `name-note` ignores it.

## 3. Octave-dependent detection
- Replace `midiToName` comparison with **MIDI-exact** comparison.
- Each target now has an exact MIDI value. Mic must hit that MIDI ± tolerance (cents).
- Tuner meter recalculated against the target MIDI when a game is active, otherwise nearest note.

## 4. Guitar tuner (pre-game)
- New **Tuner** card above the game (collapsible). Shows the 6 open strings as pills; the currently detected string lights up and shows cents off with a needle. Green within ±5¢.
- "Start tuning" enables mic; "Done" closes it. Available any time, also surfaced via a "Tune first 🎵" CTA when entering a mic-based mode for the first time.

## 5. Sound feedback
- Tiny WebAudio beeps generated on the fly (no asset files): pleasant chime on correct, soft buzz on wrong. Mute toggle in header.

## 6. Fretboard redesign
- **0-fret renders as a thick light "nut"**, fret 1+ as thinner metal wires; no more left-edge nut bar — the nut IS fret 0.
- **Fret numbers on top AND bottom**, larger, higher contrast.
- **Fret markers (inlays)** become **golden** (`#d4af37`) and larger; double dot at fret 12.
- String name labels: larger, bolder, both sides of the board.
- Note name on the fretboard is **hidden in `find-note` and `guitar` modes** — target shows as a glowing highlighted dot only. Below the fretboard, **4 multiple-choice note buttons** appear (1 correct + 3 distractors) for the player to identify the highlighted dot's note.
- In `name-note` mode the existing 13-note picker becomes 4 choices too (consistent).
- "Show all notes" mode: bigger circles, color-coded by note (12 distinct hues), readable text.

## 7. New "All strings" mode
- Toggle/mode where a target note name must be played on **every selected string** (in any order) before advancing. Progress chips show which strings are still pending.

## 8. Practice filter layout
- Strings grid: **4 per row** (using wider buttons, bolder text).
- Notes grid: **6 per row**, larger.
- Each cell shows per-item accuracy badge from §1.

## 9. Fullscreen mode
- Header button toggles `document.fullscreenElement` on the app container. Icon swaps expand/compress.

## 10. Mobile fit
- Use `h-[100dvh]` container with `overflow-hidden`, internal sections sized with `clamp()` and `flex-1 min-h-0` so the whole game fits one mobile viewport without scrolling. Fretboard scales via responsive row heights (`h-7 sm:h-10`) and smaller paddings on mobile.

## 11. Guided tour
- "Tour" button in header opens a lightweight step-through overlay (no extra dep — custom component using fixed positioning + refs) highlighting: mode tabs, filters, tuner, tolerance slider, fretboard, choice buttons, progress panel, mic, fullscreen, sound, tour itself. Stored in `localStorage` so it auto-opens once on first visit.

## Technical notes
- New helpers (top of file):
  - `midiAt(stringIdx, fret)` returns exact MIDI.
  - `centsBetween(freqDetected, midiTarget)`.
  - `playTone(type: "correct"|"wrong"|"tick")` using a shared `AudioContext`.
  - `pickChoices(correct, n=4)` picks 3 random distractors from `NOTE_NAMES`.
- New state: `tolerance`, `soundOn`, `isFullscreen`, `sessionStats` (`{attempts, correct, perCell: Record<"s:f", {a,c}>}`), `allStringsProgress` (`Set<stringIdx>`), `tunerOpen`, `tourStep`.
- Mic detection loop updated to compare exact MIDI when a game is active; otherwise feeds tuner UI.
- All colors via existing zinc/amber palette + new gold `#d4af37` for inlays and a 12-hue note map for "show all".

## Out of scope
- No persistent user accounts, no leaderboard, no backend. Per-cell stats and tour-seen flag use `localStorage`.

Ready to build on approval.
