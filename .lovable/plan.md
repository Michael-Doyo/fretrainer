# Art Progress Report Generator — Build Plan

Paste this plan (with your original prompt) into a **new Lovable project**. Fretwise stays untouched.

## Stack

- TanStack Start (React 19 + Vite 7, Cloudflare Workers runtime) — replaces the Express/Vite loop in your prompt.
- Tailwind v4 + shadcn/ui + Lucide icons.
- Server functions (`createServerFn`) for AI + export endpoints. No Express.
- AI provider: **your own API key**. I'll ask which provider on kickoff (OpenAI, Anthropic, Google, OpenRouter, etc.), store it via the secure secret form (e.g. `OPENAI_API_KEY`), and call it from a server function. Falls back to the local template compiler if the key is missing or the call fails.
- Persistence: **needs one more decision** — Lovable Cloud (multi-teacher, login, shared class data) or browser localStorage (single device, no login). Default to localStorage unless you say otherwise; Cloud can be added later without rewriting the UI.
- Exports: server-side real `.docx` (docx library) and `.pdf` (pdf-lib) generated in server functions and streamed as downloads. No html2canvas/jsPDF.

## Feature scope (mirrors your prompt)

1. **Types** (`src/types.ts`) — exactly as specified: `PronounStyle`, `WritingStyle`, `Criterion`, `StudentProfile`, `CriterionSelection`, `PortfolioItem`, `Student`.
2. **Criteria data** (`src/data/criteria.ts`)
   - 4 core discipline criteria with all 5 rating phrases verbatim.
   - Term-by-term academic criteria for Grades 1–4, Terms 1–3, generated from your syllabus with full L1–L5 phrases each.
   - `getAcademicCriteria(grade, term)` fallback for Kindergarten, Grade 5, Grade 6.
3. **Default students** (`src/data/defaultStudents.ts`) — seeded mock roster for testing.
4. **Grading** — exact 70/30 weighting, A+ → F scale, live letter/color badges.
5. **Narrative compiler**
   - `src/lib/narrative.functions.ts` server fn: calls your chosen provider with the tonal profile (natural / academic / straightforward), word-count cap, and the banned-filler prompt guardrails.
   - `src/utils/localNarrative.ts` client fallback: pronoun parser (`[[they]] [[their]] [[them]] [[themself]]` with capitalization), phrase splicing, target word count enforcement.
6. **Exports** (`src/lib/reportCompiler.functions.ts`)
   - Individual student `.docx` with Kelem International School branding, rubric matrix, narrative.
   - Cohort `.docx` roster table (grades + letters + comments).
   - Grade-only / narrative-only export filters.
   - Annual Curriculum Guide `.pdf` from the syllabus arrays.
7. **UI**
   - `MarkBookDashboard` — editable spreadsheet grid, double-click cells, reactive letter/color badges.
   - `StudentProfileForm` — sidebar with pronoun, writing style, activity focus, target word count, personal statement.
   - `PortfolioShowcase` — responsive gallery per student (image, caption, date, self-reflection, teacher feedback).
   - `WordCompilerModal` + `StudentSpellingModal` — spelling word compilers.
   - `AddStudentModal`, `EvaluationCriteriaGrid` — auxiliary inputs.
   - `src/routes/index.tsx` — central coordinator with filters and view overlays.
   - Palette: deep slate/charcoal + off-white, dense readable layout, generous whitespace, desktop-first + mobile responsive.

## Technical notes (for reference)

```text
src/
  types.ts
  data/{criteria.ts, defaultStudents.ts, syllabus.ts}
  utils/{grading.ts, pronouns.ts, localNarrative.ts}
  lib/
    narrative.functions.ts        // createServerFn → your AI provider
    reportCompiler.functions.ts   // createServerFn → docx / pdf-lib, returns base64 or streams
  components/{MarkBookDashboard, StudentProfileForm, PortfolioShowcase, WordCompilerModal, StudentSpellingModal, AddStudentModal, EvaluationCriteriaGrid}.tsx
  routes/{__root.tsx, index.tsx}
```

- Server functions read `process.env.<YOUR_KEY>` inside `.handler()` — never at module scope.
- Downloads: server fn returns `{ filename, mimeType, base64 }`; client triggers a blob download. Word MIME `application/vnd.openxmlformats-officedocument.wordprocessingml.document`; PDF `application/pdf`.
- No Express, no HMR proxy — the TanStack Vite plugin already handles dev/HMR and Worker SSR.

## Two questions I'll ask first in the new project

1. Which AI provider + model (I'll set up the matching secret and SDK).
2. Lovable Cloud login/shared database, or localStorage only?
