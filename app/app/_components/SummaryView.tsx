/** What the player sees after a question ends: their answers, points and the reveal. */
import { formatValue } from "@/lib/client/state";
import type { Question, Summary } from "@/lib/client/types";
import { LeftItem } from "./MatchPlay";
import { GivenList } from "./TextPlay";

export function SummaryView({ question, summary }: { question: Question; summary: Summary }) {
  return (
    <div role="status">
      <p><strong>{question.text}</strong></p>
      {question.kind === "free_text" && <TextSummary summary={summary} />}
      {question.kind === "match" && <MatchSummary question={question} summary={summary} />}
      {question.kind === "order" && <OrderSummary question={question} summary={summary} />}
      <p>Points for this question: <strong>{summary.points}</strong></p>
    </div>
  );
}

function TextSummary({ summary }: { summary: Summary }) {
  return (
    <>
      {summary.answers.length ? <GivenList answers={summary.answers} /> : <p>No answers given.</p>}
      {!!summary.commonAnswers?.length &&
        <p>Most common answers: {summary.commonAnswers.map((a) => a.name).join(", ")}</p>}
      {!!summary.rareAnswers?.length &&
        <p>Some rare answers: {summary.rareAnswers.map((a) => a.name).join(", ")}</p>}
      {summary.fact && (
        <aside style={{ borderLeft: "3px solid #999", paddingLeft: "0.75em" }}>
          <p><strong>Rare find: {summary.fact.name}</strong><br />{summary.fact.text}</p>
        </aside>
      )}
    </>
  );
}

function MatchSummary({ question, summary }: { question: Question; summary: Summary }) {
  const right = question.right ?? [];
  const label = (pos?: number) => (pos === undefined || pos < 0 ? "—" : right.find((r) => r.pos === pos)?.label ?? "?");
  return (
    <table>
      <tbody>
        {(question.left ?? []).map((l, i) => {
          const ok = summary.correct?.[i];
          const mine = summary.pairs?.[i];
          return (
            <tr key={l.pos}>
              <td><LeftItem item={l} n={i + 1} /></td>
              <td>→</td>
              <td>
                {ok ? "✓" : "✗"} {label(summary.solution?.[i])}
                {!ok && mine !== undefined && mine >= 0 && <> (you said <s>{label(mine)}</s>)</>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OrderSummary({ question, summary }: { question: Question; summary: Summary }) {
  const items = question.items ?? [];
  const label = (pos: number) => items.find((it) => it.pos === pos)?.label ?? "?";
  return (
    <>
      <p>The right order:</p>
      <ol>
        {(summary.solution ?? []).map((pos, i) => (
          <li key={pos}>
            {summary.correct?.[i] ? "✓" : "✗"} {label(pos)}
            {summary.values && ` · ${formatValue(summary.values[pos], summary.unit ?? "")}`}
            {summary.order && !summary.correct?.[i] && <> (you put <s>{label(summary.order[i])}</s>)</>}
          </li>
        ))}
      </ol>
    </>
  );
}
