/**
 * Plays a full day in a real browser under the timed rules: start each question, several answers,
 * an unrecognised try, a "did you mean" confirm, a matching round (with flags when the copied day
 * has one), an ordering round, a question left to time out, the end screen, then reload and
 * revisit. Uses a copy of a generated puzzle on a sandbox date and deletes everything afterwards.
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

/** The three most popular valid answers per free-text question; payloads for the rounds. */
async function solutions(): Promise<Row[]> {
  return (await pool.query<Row>(
    `SELECT q.idx, q.kind, q.payload,
       ARRAY(SELECT e.name FROM entities e WHERE e.id = ANY(q.valid_entity_ids)
             ORDER BY e.popularity DESC NULLS LAST LIMIT 3) AS names
     FROM puzzle_questions q WHERE q.date = $1 ORDER BY q.idx`,
    [E2E_DATE],
  )).rows;
}

/** E2E_SHOTS=<dir> saves screenshots of each step (for eyeballing the UI). */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true });
}

async function answer(page: Page, text: string) {
  await page.getByLabel("Answer").fill(text);
  await page.getByLabel("Answer").press("Enter");
}

test("play a whole day", async ({ page }) => {
  test.setTimeout(240_000);
  const rows = await solutions();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start question 1" })).toBeVisible();
  playerId = await page.evaluate(() => localStorage.getItem("gr_pid"));
  expect(playerId).toMatch(/^[0-9a-f-]{36}$/);
  // question text is hidden until the question starts
  await expect(page.getByText(rows[0].kind === "free_text" ? /Name a/ : /Match|Order/)).toHaveCount(0);

  let triedExtras = false;
  for (const [i, row] of rows.entries()) {
    const last = i === rows.length - 1;
    await page.getByRole("button", { name: `Start question ${i + 1}` }).click();
    await expect(page.getByText(/⏱ \d+s/)).toBeVisible();

    if (row.kind === "match") {
      const labels = row.payload!.pairs!.map((p) => p.right_label);
      if (row.payload!.variant === "match_flag_country") {
        const imgs = page.locator("img");
        await expect(imgs).toHaveCount(labels.length);
        for (const img of await imgs.all()) {
          await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
          expect(await img.getAttribute("src")).toMatch(/^\/api\/flag\/[\d-]+\/\d\/\d$/);
        }
      }
      for (const [n, label] of labels.entries()) {
        await page.locator("select").nth(n).selectOption({ label });
      }
      await shot(page, `q${i + 1}-match`);
      await page.getByRole("button", { name: "Submit pairs" }).click();
      await expect(page.getByText(/Points for this question: \d+/)).toBeVisible();
      await expect(page.getByText("✗")).toHaveCount(0);
    } else if (row.kind === "order") {
      const items = row.payload!.items!.map((it) => it.label);
      const want = row.payload!.answer!.map((p) => items[p]);
      // selection sort with the ↑ buttons
      for (const [t, label] of want.entries()) {
        for (;;) {
          const current = await page.locator("section ol li").allInnerTexts();
          const at = current.findIndex((txt) => txt.startsWith(label));
          if (at <= t) break;
          await page.getByRole("button", { name: `Move ${label} up` }).click();
        }
      }
      await shot(page, `q${i + 1}-order`);
      await page.getByRole("button", { name: "Submit order" }).click();
      await expect(page.getByText("Points for this question: 100")).toBeVisible();
    } else if (last) {
      // leave the last question to run out: the summary appears on its own
      await expect(page.getByText(/Points for this question/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("No answers given.")).toBeVisible();
    } else {
      const names = row.names!;
      if (!triedExtras) {
        triedExtras = true;
        await answer(page, "qqxzvb");
        await expect(page.getByText(/not recognised/)).toBeVisible();
        // a misspelling is suggested, not counted until confirmed
        const long = names.find((n) => n.length >= 6 && /^[A-Za-z ]+$/.test(n));
        if (long) {
          const typo = long.slice(0, 3) + long.slice(4);
          await answer(page, typo);
          const yes = page.getByRole("button", { name: `${long}?` });
          await expect(yes).toBeVisible();
          await shot(page, `q${i + 1}-did-you-mean`);
          await yes.click();
          await expect(page.getByText(new RegExp(`✓ ${long}`))).toBeVisible();
        }
      }
      for (const name of names) {
        if (await page.getByText(new RegExp(`✓ ${name}\\b`)).count()) continue;
        await answer(page, name);
        const dym = page.getByRole("button", { name: `${name}?` });
        const ok = page.getByText(new RegExp(`✓ ${name}\\b`));
        await expect(dym.or(ok).first()).toBeVisible();
        if (await dym.isVisible()) await dym.click();
        await expect(ok).toBeVisible();
      }
      await shot(page, `q${i + 1}-playing`);
      await page.getByRole("button", { name: "I'm done" }).click();
      await expect(page.getByText(/Points for this question: \d+/)).toBeVisible();
      await expect(page.getByText(/Most common answers/)).toBeVisible();
    }
    await shot(page, `q${i + 1}-summary`);
    await page.getByRole("button", { name: last ? "See results" : "Next question" }).click();
  }

  await expect(page.getByRole("heading", { name: "Today's results" })).toBeVisible();
  await expect(page.locator("pre")).toContainText(`Geo-rarity ${E2E_DATE}`);
  await expect(page.getByText(/Next puzzle in \d+h \d\dm/)).toBeVisible();
  await shot(page, "end");

  // reload → straight to the end screen; revisiting a question shows its summary
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today's results" })).toBeVisible();
  await page.getByRole("button", { name: /^1 · \d+$/ }).click();
  await expect(page.getByText(/Points for this question/)).toBeVisible();
  await expect(page.getByLabel("Answer")).toHaveCount(0);
});
