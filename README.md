# Mnemora — spaced-repetition flashcards

Local-first flashcard app (React + TypeScript + Vite + Tailwind) with real **FSRS-5** scheduling, offline storage in IndexedDB,
and optional cloud accounts + sync through **Supabase** (Postgres, Auth, Storage, Row Level Security).

> **Honest status.** The npm registry was unreachable while this was written, so `npm install` / `vite build` / `tsc -b` on the
> full project have **not** been run. Everything else was verified (see *Test results*). Run `npm install && npm run build`
> first; if the compiler reports a type error in a `.tsx` file, it is a genuine thing to fix, not a sign of a broken design.

## Quick start

```bash
npm install
npm run dev            # http://localhost:5173  — works immediately in LOCAL MODE (no env needed)
npm test               # unit tests (87)
npm run bench          # 50k-card performance check
npm run build          # type-check + production build into dist/
```

Without a `.env.local` the app runs in **local mode**: cards live in this browser's IndexedDB; no accounts, no sync.

## Enabling accounts and sync (needs your Supabase project)

1. Create a project at supabase.com.
2. SQL editor → run, in order: `supabase/migrations/0001_schema.sql`, `0002_rls.sql`, `0003_storage.sql`.
3. `cp .env.example .env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the **anon/public** key).
   **Never** put the `service_role` key in the frontend — the app detects it and refuses to use it.
4. Auth → URL configuration: add your dev and production URLs to *Site URL* / *Redirect URLs* (needed for e-mail confirmation,
   password reset and Google).
5. Google sign-in: Auth → Providers → Google, add your OAuth client ID/secret.
6. Deleting the *auth user* itself needs a server-side Edge Function with the service role (not included). The in-app
   "Delete my cloud data" button calls the `delete_my_data()` RPC, which removes all rows and files but not the login.

## Deploy

The host runs `npm install` and `npm run build` itself, so no local build is needed. Config files are included:

- **Netlify:** push the repo, "Import from Git". `netlify.toml` sets build command, `dist/`, security headers and a CSP.
- **Vercel / Cloudflare Pages:** framework preset *Vite*, build `npm run build`, output `dist`. `vercel.json` carries the same headers.
- **GitHub Pages:** push to `main`; `.github/workflows/deploy.yml` runs tests, builds and publishes (set repo secrets
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and Pages source = GitHub Actions). It builds with `VITE_BASE=./` for sub-paths.

In every case set the two `VITE_` variables in the host's settings (or leave empty for local-only mode). Routing is hash-based
(`/#/decks`) so no rewrite rules are needed. The service worker is registered in production builds only. The CSP allows
`https://*.supabase.co` and Google Fonts; if you use a custom Supabase domain, add it to `connect-src`.

## Architecture

```
src/db/collection.ts   in-memory Collection (Maps) write-through to Persistence; all card/deck/note logic, queue, undo, search
src/db/persistence.ts  IndexedDB + in-memory implementations, sync outbox, conflicts, media blobs
src/db/sync.ts         transport-agnostic SyncEngine (pull-then-push, keyset cursor, merge rules, retries, integrity check)
src/db/supabaseTransport.ts   Supabase implementation of the transport
src/lib/fsrs.ts        FSRS-5 (19 parameters, per-user optimisable); scheduler.ts adds Anki-style learning/relearning steps
src/lib/…              cloze, render, sanitize (DOMPurify), search syntax, stats, CSV/JSON/backup, achievements, i18n, router, media
src/pages, components  Home, Decks, Study, Add, Browse, Statistics, Import/Export, Settings, Auth
supabase/migrations    schema, RLS, storage bucket, server-side guards
tests/                 node:test unit tests, SQL/RLS tests (real Postgres), bench
```

Sync rules: review logs are append-only; a card keeps whichever side has the newer `last_review`/more reps (so an old device can
never overwrite newer review history — enforced both in the client merge and by a Postgres trigger); other rows are last-write-wins
on `updated_at`; true conflicts are recorded and can be resolved in Settings → Data. Rejected rows are quarantined, never dropped.

## Test results (what was actually run)

| Check | Result |
|---|---|
| `tsx --test tests/*.test.ts` (FSRS, scheduler, collection, sync, import/export, stats, steps, achievements) | **87 / 87 pass** |
| SQL schema + RLS + guards on real PostgreSQL 16 (`tests/sql/run.sh`) | **48 / 48 pass** (run before the last README edit; migrations unchanged since) |
| Bench, 50 000 cards, in memory | add 1.6 s total · queue build ≈ 85 ms · search 40–140 ms · answer a card ≈ 0.1 ms |
| Browser smoke test (real Chromium + real IndexedDB; UI bundled with esbuild, **framer-motion / lucide / recharts replaced by stubs**) | **16 / 16 pass**, no console errors: boot, every route, add card, browse, study (flip + answer by keyboard), persistence across reload, create deck, all settings tabs, mobile viewport |
| `tsc` on non-UI modules (db, lib, types) | clean, apart from `dompurify` typings missing in the sandbox |
| `npm install`, `tsc -b` on `.tsx`, `vite build`, real Recharts/Framer/Lucide rendering, Tailwind CSS output | **NOT run** |
| Any call to a real Supabase project (auth, sync, storage, Google) | **NOT run** — transport is tested against a fake server that mirrors the SQL guards; SQL is tested separately |

## Features

Implemented: dashboard from real data; nested decks (create/rename/delete/duplicate/move, per-deck options); note types Basic,
Basic-reversed, optional-reversed, Cloze, MCQ, Image-occlusion, Audio, custom templates; rich text + HTML, tags, drafts, duplicates;
study screen with flip, Again/Hard/Good/Easy + intervals, keyboard 1–4/Space, undo, suspend/edit while studying; FSRS with
per-deck desired retention, steps, limits and global parameters; browse with search syntax (`deck:"A::B" tag:x is:due` …), filters,
sorting, bulk actions, pagination; statistics (heatmap, forecast, retention, intervals, states, hours); CSV/JSON import & export
(with column mapping, formula-injection guard), full backup/restore (merge or replace); auth (e-mail, Google, reset, profile);
offline + service worker app-shell; auto/manual sync with conflicts; settings (general/study/review/account/data), global
search (Ctrl/⌘+K), shortcuts (editable), daily goals, streaks, achievements, in-page reminders, public/private deck flag.

**Needs your credentials to use:** accounts, sync, cloud media, Google sign-in (all above).

**Not implemented / limits (deliberate, to avoid fake claims):**
- **Anki `.apkg` import/export** — not implemented, so no Anki compatibility is claimed (CSV/JSON are supported).
- Browsing/cloning *other users'* public decks — only the `is_public` flag and its RLS policy exist.
- Reminders are in-page notifications while the app is open; real push needs a push server.
- Translations: English, Uzbek, Russian for navigation and the study screen only.
- FSRS is implemented in-repo (not the `ts-fsrs` package); parameter *optimisation from history* is not included (you can paste parameters).
- Deleting the auth user requires an Edge Function (see above).
