/**
 * Plays a full day in a real browser: a wrong-type/unrecognised try, valid answers, a matching
 * round, the end screen and share text, then reload (resume) and revisiting a question.
 * Uses a copy of a generated puzzle on a sandbox date and deletes everything afterwards.
 */
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { databaseUrl } from "../lib/db";
import { E2E_DATE } from "../playwright.config";

const pool = new Pool({ connectionString: databaseUrl() });
let playerId: string | null = null;

interface Row {
  idx: number; kind: string; payload: { pairs?: { right_label: string }[] } | null; best: string | null;
}

async function cleanup() {
  for (const t of ["daily_scores", "answer_attempts", "unmatched_log", "answer_counts", "answers", "daily_puzzles"]) {
    await pool.query(`DELETE FROM ${t} WHERE date = $1`, [E2E_DATE]);
  }
  if (playerId) {
    await pool.query("DELETE FROM player_stats WHERE player_id = $1", [playerId]);
    await pool.query("DELETE FROM players WHERE id = $1", [playerId]);
  }
}

test.beforeAll(async () => {
  await cleanup();
  const { rows } = await pool.query<{ date: string }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date FROM puzzle_questions
     WHERE kind = 'match' AND payload->>'variant' = 'match_flag_country' AND date > '2000-01-01'
     GROUP BY date ORDER BY date LIMIT 1`,
  );
  if (!rows[0]) throw new Error("no generated day with a flag matching round: run make generate");
  await pool.query("INSERT INTO daily_puzzles (date) VALUES ($1)", [E2E_DATE]);
  await pool.query(
    `INSERT INTO puzzle_questions (date, idx, template_id, params, question_text, valid_entity_ids,
       family, entity_type, difficulty, stats, kind, payload)
     SELECT $1, idx, template_id, params, question_text, valid_entity_ids, family, entity_type,
       difficulty, stats, kind, payload FROM puzzle_questions WHERE date = $2`,
    [E2E_DATE, rows[0].date],
  );
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

/** Most popular valid answer per free-text question; the pairs for the matching round. */
async function solutions(): Promise<Row[]> {
  return (await pool.query<Row>(
    `SELECT q.idx, q.kind, q.payload,
       (SELECT e.name FROM entities e WHERE e.id = ANY(q.valid_entity_ids)
        ORDER BY e.popularity DESC NULLS LAST LIMIT 1) AS best
     FROM puzzle_questions q WHERE q.date = $1 ORDER BY q.idx`,
    [E2E_DATE],
  )).rows;
}

/** E2E_SHOTS=<dir> saves screenshots of each step (for eyeballing the UI). */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true });
}

async function answerText(page: Page, text: string) {
  await page.getByLabel("Your answer").fill(text);
  await page.getByRole("button", { name: "Submit" }).click();
}

test("play a whole day", async ({ page }) => {
  const rows = await solutions();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Question 1 of 6/ })).toBeVisible();
  playerId = await page.evaluate(() => localStorage.getItem("gr_pid"));
  expect(playerId).toMatch(/^[0-9a-f-]{36}$/);

  let triedGibberish = false;
  for (const [i, row] of rows.entries()) {
    await expect(page.getByRole("heading", { name: new RegExp(`Question ${i + 1} of 6`) })).toBeVisible();
    if (row.kind === "match") {
      const labels = row.payload!.pairs!.map((p) => p.right_label);
      // flag images load, and their URLs don't name the country
      const imgs = page.locator("img");
      await expect(imgs).toHaveCount(labels.length);
      for (const img of await imgs.all()) {
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
        expect(await img.getAttribute("src")).toMatch(/^\/api\/flag\/[\d-]+\/\d\/\d$/);
      }
      for (const [n, label] of labels.entries()) {
        await page.locator("select").nth(n).selectOption({ label });
      }
      await shot(page, `q${i + 1}-match`);
      await page.getByRole("button", { name: "Submit pairs" }).click();
      await expect(page.getByText(`${labels.length} of ${labels.length} right`)).toBeVisible();
    } else {
      if (!triedGibberish) {
        triedGibberish = true;
        await answerText(page, "qqxzvb");
        await expect(page.getByText(/tries left before it counts as 0/)).toBeVisible();
        await shot(page, `q${i + 1}-unrecognised`);
      }
      await answerText(page, row.best!);
      const dym = page.getByText("Did you mean…");
      const ok = page.getByText(/is right!/);
      await expect(dym.or(ok)).toBeVisible();
      if (await dym.isVisible()) {
        await page.getByRole("button", { name: row.best!, exact: true }).click();
      }
      await expect(ok).toBeVisible();
    }
    await shot(page, `q${i + 1}-result`);
    await page.getByRole("button", { name: i === rows.length - 1 ? "See results" : "Next question" }).click();
  }

  await expect(page.getByRole("heading", { name: "Today's results" })).toBeVisible();
  await expect(page.locator("pre")).toContainText(`Geo-rarity ${E2E_DATE}`);
  await expect(page.getByText(/Next puzzle in \d+h \d\dm/)).toBeVisible();
  await shot(page, "end");

  // reload → straight to the end screen; revisiting a question shows the stored result
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today's results" })).toBeVisible();
  const firstText = rows.findIndex((r) => r.kind !== "match");
  await page.getByRole("button", { name: new RegExp(`^${firstText + 1} `) }).click();
  await expect(page.getByText(/is right!/)).toBeVisible();
  await expect(page.getByLabel("Your answer")).toHaveCount(0);
});
