/**
 * Browser test: plays a whole day through the real UI (PLAN.md Phase 5 "playable end to end").
 * Runs a dev server on port 3100 pinned to a sandbox date (see e2e/play.e2e.ts). Needs the
 * local database (`make db`) and generated puzzles (`make generate`).
 */
import { defineConfig } from "@playwright/test";

export const E2E_DATE = "1999-01-10";
const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 120_000,
  workers: 1,
  expect: { timeout: 20_000 }, // the dev server compiles each route on first use
  use: { baseURL: `http://localhost:${PORT}`, headless: true },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    env: { GAME_TODAY: E2E_DATE },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
