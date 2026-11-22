/**
 * Plays a full day in a real browser under the timed one-correct-answer rules: start each
 * question, an unrecognised try, a wrong place (retry allowed), a "did you mean" confirm that
 * ends the question, a matching round (tap to pair, with flags when the copied day has one), an
 * ordering round, a question left to time out, the end screen, then reload (results from the
 * local cache) and revisit. Uses a copy of a generated puzzle on a sandbox date and deletes
 * everything afterwards.
 */
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { databaseUrl } from "../lib/db";
import { E2E_DATE } from "../playwright.config";

const pool = new Pool({ connectionString: databaseUrl() });
let playerId: string | null = null;

interface Row {
  idx: number;
  kind: string;
  payload: {
    variant?: string;
    pairs?: { right_label: string }[];
    items?: { label: string }[];
    answer?: number[];
  } | null;
  names: string[] | null;
}

async function cleanup() {
  for (const t of ["daily_scores", "question_plays", "unmatched_log", "answer_counts", "answers", "daily_puzzles"]) {
    await pool.query(`DELETE FROM ${t} WHERE date = $1`, [E2E_DATE]);
  }
  if (playerId) {
    await pool.query("DELETE FROM player_stats WHERE player_id = $1", [playerId]);
    await pool.query("DELETE FROM players WHERE id = $1", [playerId]);
  }
}

test.beforeAll(async () => {
  await cleanup();
  // a day with an ordering round, preferring one whose matching round is flags
  const { rows } = await pool.query<{ date: string }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date FROM puzzle_questions WHERE date > '2000-01-01'
     GROUP BY date HAVING bool_or(kind = 'order') AND bool_or(kind = 'match')
     ORDER BY bool_or(payload->>'variant' = 'match_flag_country') DESC, date LIMIT 1`,
  );
  if (!rows[0]) throw new Error("no generated day with matching + ordering rounds: run make generate");
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

/** Popular valid answers per free-text question, a wrong place of the same type, round payloads. */
async function solutions(): Promise<(Row & { wrong: string | null })[]> {
  return (await pool.query<Row & { wrong: string | null }>(
    `SELECT q.idx, q.kind, q.payload,
       ARRAY(SELECT e.name FROM entities e WHERE e.id = ANY(q.valid_entity_ids)
             ORDER BY e.popularity DESC NULLS LAST LIMIT 3) AS names,
       (SELECT e.name FROM entities e WHERE e.type = q.entity_type AND NOT (e.id = ANY(q.valid_entity_ids))
          AND e.name ~ '^[A-Za-z ]+$' ORDER BY e.popularity DESC NULLS LAST LIMIT 1) AS wrong
     FROM puzzle_questions q WHERE q.date = $1 ORDER BY q.idx`,
    [E2E_DATE],
  )).rows;
}

/** E2E_SHOTS=<dir> saves screenshots of each step (for eyeballing the UI). */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true });
}

async function answer(page: Page, text: string) {
  await page.getByLabel("Answer", { exact: true }).fill(text);
  await page.getByLabel("Answer", { exact: true }).press("Enter");
}

const pointsLine = (page: Page) => page.locator(".points-line");

test("play a whole day", async ({ page }) => {
  test.setTimeout(240_000);
  const rows = await solutions();
  await page.goto("/");
  // first visit: the rules open by themselves
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByRole("button", { name: "Start question 1" })).toBeVisible();
  playerId = await page.evaluate(() => localStorage.getItem("gr_pid"));
  expect(playerId).toMatch(/^[0-9a-f-]{36}$/);
  // question text is hidden until the question starts
  await expect(page.getByText(rows[0].kind === "free_text" ? /Name a/ : /Match|Order/)).toHaveCount(0);

  let triedExtras = false;
  for (const [i, row] of rows.entries()) {
    const last = i === rows.length - 1;
    await page.getByRole("button", { name: `Start question ${i + 1}` }).click();
    await expect(page.getByRole("timer")).toBeVisible();

    if (row.kind === "match") {
      const labels = row.payload!.pairs!.map((p) => p.right_label);
      if (row.payload!.variant === "match_flag_country") {
        const imgs = page.locator(".tile img");
        await expect(imgs).toHaveCount(labels.length);
        for (const img of await imgs.all()) {
          await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
          expect(await img.getAttribute("src")).toMatch(/^\/api\/image\/[\d-]+\/\d\/\d$/);
        }
      }
      for (const [n, label] of labels.entries()) {
        await page.getByRole("button", { name: new RegExp(`^Item ${n + 1}\\b`) }).click();
        await page.getByRole("button", { name: label, exact: true }).click();
      }
      await shot(page, `q${i + 1}-match`);
      await page.getByRole("button", { name: "Submit pairs" }).click();
      await expect(pointsLine(page)).toBeVisible();
      await expect(page.locator(".tile.bad")).toHaveCount(0);
    } else if (row.kind === "order") {
      const items = row.payload!.items!.map((it) => it.label);
      const want = row.payload!.answer!.map((p) => items[p]);
      // selection sort with the ▲ buttons
      for (const [t, label] of want.entries()) {
        for (;;) {
          const current = await page.locator(".order-item .label").allInnerTexts();
          if (current.indexOf(label) <= t) break;
          await page.getByRole("button", { name: `Move ${label} up` }).click();
        }
      }
      await shot(page, `q${i + 1}-order`);
      await page.getByRole("button", { name: "Submit order" }).click();
      await expect(pointsLine(page)).toContainText("100");
    } else if (last) {
      // leave the last question to run out: the summary appears on its own
      await expect(pointsLine(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("No answers given.")).toBeVisible();
    } else {
      const names = row.names!;
      let target = names[0];
      if (!triedExtras) {
        triedExtras = true;
        await answer(page, "qqxzvb");
        await expect(page.getByText(/not recognised/)).toBeVisible();
        // a real place that doesn't fit: shown as tried, and you can go again
        if (row.wrong) {
          await answer(page, row.wrong);
          await expect(page.getByRole("list", { name: "Tried so far" })).toContainText(row.wrong);
          await expect(page.getByText(/doesn't fit/)).toBeVisible();
        }
        // a misspelling is suggested, not counted until confirmed
        target = names.find((n) => n.length >= 6 && /^[A-Za-z ]+$/.test(n)) ?? names[0];
        if (target.length >= 6) {
          await answer(page, target.slice(0, 3) + target.slice(4));
          const yes = page.getByRole("button", { name: `${target}?` });
          await expect(yes).toBeVisible();
          await shot(page, `q${i + 1}-did-you-mean`);
          await yes.click();
        } else {
          await answer(page, target);
        }
      } else {
        await answer(page, target);
        const dym = page.getByRole("button", { name: `${target}?` });
        await expect(dym.or(pointsLine(page)).first()).toBeVisible();
        if (await dym.isVisible()) await dym.click();
      }
      // one right answer ends the question
      await expect(pointsLine(page)).toBeVisible();
      await expect(page.locator(".answer-name")).toHaveText(target);
      await expect(page.getByText(/Most common answers/)).toBeVisible();
      await expect(page.getByLabel("Answer", { exact: true })).toHaveCount(0);
    }
    await shot(page, `q${i + 1}-summary`);
    await page.getByRole("button", { name: last ? /See results/ : /Next question/ }).click();
  }

  await expect(page.getByRole("heading", { name: "Today's results" })).toBeVisible();
  await expect(page.locator(".telegram")).toContainText(`Geo-rarity ${E2E_DATE}`);
  await expect(page.getByText(/Next puzzle in/)).toBeVisible();
  await shot(page, "end");

  // reload → straight to the end screen (from the local cache); a question shows its summary
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today's results" })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("gr_c:")).length))
    .toBe(2);
  await page.getByRole("button", { name: /^1 · \d+$/ }).click();
  await expect(pointsLine(page)).toBeVisible();
  await expect(page.getByLabel("Answer", { exact: true })).toHaveCount(0);
});
