# Geo-rarity daily game — project context

A daily browser game. Krillion-style rarity scoring, with geography questions spanning many place
types (countries, cities, airports, regions, national parks, forests, mountains, rivers…).
6 questions per day, same for every player. Each question has many valid answers; the rarer a
correct answer is among players, the more points it scores.

**What we ask (question families, difficulty, the "easy floor" rule) is in `QUESTIONS.md`.
The game must be playable by people who aren't geography experts.**

**The full implementation plan is in `PLAN.md`. Read it before starting any work, and work one
phase at a time. Stop at the end of each phase and summarise what was built, what's untested, and
any data-quality concerns.**

## Core architecture (do not deviate without asking)

- **One unified entity table** for places and non-place answers. Every question is a *template +
  filter* over that table. Answer checking, spelling correction and scoring are type-agnostic.
- **Wikidata QID is the canonical ID** for every entity wherever one exists. Other sources join to it.
- **Answer sets are computed at puzzle-generation time and frozen** in `daily_puzzles`. Data updates
  must never change a past puzzle.
- **Valid answer sets never leave the server.** The client only gets question text until it submits.
- **Fuzzy matching runs against ALL entities of the question's type, never only the valid set**
  (otherwise typos of wrong answers snap to right ones and players can fish for answers).

## Stack

- Data pipeline: Python 3.11+, in `/pipeline`. Raw downloads cached in `/pipeline/raw` (gitignored).
  Normalised output as Parquet in `/pipeline/out`, then loaded into Postgres.
- Database: Postgres (Supabase, or local Postgres via Docker for dev) with `pg_trgm` and `unaccent`.
- App: Next.js (App Router, TypeScript) in `/app`. API routes for game logic.
- Tests: pytest for pipeline + matcher fixtures; Vitest for app logic.

## Conventions

- Every ingest script is idempotent and re-runnable; never re-download if a cached raw file exists
  (add a `--refresh` flag).
- Record source + licence + "as of" date for every dataset in `pipeline/SOURCES.md`.
- Only use sources compatible with commercial use. **Do not use WDPA / Protected Planet.**
- Attribution required for ODbL (OpenStreetMap, mledoze/countries) and CC BY (GeoNames): keep a list
  for the credits page.
- Keep UI unstyled/minimal; design comes later.
- Commit at the end of each phase with a clear message.

