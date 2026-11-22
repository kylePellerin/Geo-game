"use client";
/** What the player sees after a question ends: their stamp, the reveal and a fact card. */
import { formatShare, formatValue } from "@/lib/client/state";
import type { Question, Summary } from "@/lib/client/types";
import { Burst, roundTier, Stamp, tilt } from "./Bits";
import { LeftItem, Pin } from "./MatchPlay";
import { ends } from "./OrderPlay";

export function SummaryView({ question, summary, fresh, head, children }: {
  question: Question; summary: Summary; fresh: boolean;
  head: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="card" role="status">
      {head}
      <h2 className="question-text" style={{ fontSize: "clamp(1.15rem, 4vw, 1.45rem)" }}>{question.text}</h2>
      {question.kind === "free_text" && <TextSummary summary={summary} fresh={fresh} />}
      {question.kind === "match" && <MatchSummary question={question} summary={summary} fresh={fresh} />}
      {question.kind === "order" && <OrderSummary question={question} summary={summary} fresh={fresh} />}
      <div className="points-line">
        <span>Points for this question</span>
        <b>{summary.points}</b>
      </div>
      <span className="sr-only">Points for this question: {summary.points}</span>
      {children}
    </div>
  );
}

function TextSummary({ summary, fresh }: { summary: Summary; fresh: boolean }) {
  const right = summary.answers.find((a) => a.status === "valid");
  const wrong = summary.answers.filter((a) => a.status !== "valid");
  const mine = right?.entity.id;
  return (
    <>
      <div className="result-banner">
        {right ? (
          <>
            <Stamp tier={right.tier} points={right.points} big slam={fresh} rotate={tilt(right.entity.id)} />
            <div>
              <div className="answer-name">{right.entity.name}</div>
              <div className="answer-sub">
                {right.share !== undefined
                  ? <>About {formatShare(right.share)} of players said this.</>
                  : <>A right answer.</>}
              </div>
            </div>
            {fresh && (right.tier === "obscure" || right.tier === "rarest") && <Burst tier={right.tier} />}
          </>
        ) : (
          <>
            <Stamp tier="wrong" label={wrong.length ? "Missed" : "No answer"} points="0" big slam={fresh} />
            <div>
              <div className="answer-name">{wrong.length ? "Not this time" : "Time's up"}</div>
              <div className="answer-sub">
                {wrong.length ? <>You tried {wrong.map((w) => w.entity.name).join(", ")}.</> : <>No answers given.</>}
              </div>
            </div>
          </>
        )}
      </div>
      <hr className="divider" />
      <div className="notes">
        {!!summary.commonAnswers?.length && (
          <div>
            <h3>Most common answers</h3>
            <ul>{summary.commonAnswers.map((a) => <li key={a.id} className={a.id === mine ? "mine" : ""}>{a.name}</li>)}</ul>
          </div>
        )}
        {!!summary.rareAnswers?.length && (
          <div className="rare">
            <h3>Rare answers people found</h3>
            <ul>{summary.rareAnswers.map((a) => <li key={a.id} className={a.id === mine ? "mine" : ""}>{a.name}</li>)}</ul>
          </div>
        )}
      </div>
      {summary.fact && (
        <aside className="postcard">
          <span className="postmark">Field note</span>
          <h4>{summary.fact.name}</h4>
          <p>{summary.fact.text}</p>
        </aside>
      )}
    </>
  );
}

function RoundStamp({ summary, n, fresh }: { summary: Summary; n: number; fresh: boolean }) {
  const right = summary.correct?.filter(Boolean).length ?? 0;
  const tier = roundTier(right, n);
  return (
    <div className="result-banner">
      <Stamp tier={tier} label={`${right} / ${n}`} points={summary.points} big slam={fresh} rotate="-6deg" />
      <div>
        <div className="answer-name">
          {right === n ? "Perfect!" : right === 0 ? "Tough one" : right >= n / 2 ? "Nicely done" : "Some right"}
        </div>
        <div className="answer-sub">{right} of {n} in the right place.</div>
      </div>
      {fresh && right === n && <Burst tier="rarest" />}
    </div>
  );
}

function MatchSummary({ question, summary, fresh }: { question: Question; summary: Summary; fresh: boolean }) {
  const right = question.right ?? [];
  const label = (pos?: number) => (pos === undefined || pos < 0 ? "nothing" : right.find((r) => r.pos === pos)?.label ?? "?");
  const left = question.left ?? [];
  const decoys = right.filter((r) => !summary.solution?.includes(r.pos));
  return (
    <>
      <RoundStamp summary={summary} n={left.length} fresh={fresh} />
      <div className="match-summary">
        {left.map((l, i) => {
          const ok = summary.correct?.[i];
          const mine = summary.pairs?.[i];
          return (
            <div key={l.pos} className={`tile ${ok ? "ok" : "bad"}`} data-paired="true">
              <Pin i={i} />
              <LeftItem item={l} n={i + 1} />
              <span style={{ marginLeft: "0.4rem" }}>
                → {label(summary.solution?.[i])}
                {!ok && mine !== undefined && <s>you said {label(mine)}</s>}
              </span>
              <span className="verdict">{ok ? "✓" : "✗"}</span>
            </div>
          );
        })}
      </div>
      {decoys.length > 0 && (
        <p className="hint">Matched nothing: {decoys.map((d) => d.label).join(" · ")}</p>
      )}
    </>
  );
}

function OrderSummary({ question, summary, fresh }: { question: Question; summary: Summary; fresh: boolean }) {
  const items = question.items ?? [];
  const label = (pos: number) => items.find((it) => it.pos === pos)?.label ?? "?";
  const [top] = ends(question.text);
  return (
    <>
      <RoundStamp summary={summary} n={items.length} fresh={fresh} />
      <div className="order-ends"><span>The right order · {top.replace("▲ ", "")} first</span></div>
      <ol className="order-list">
        {(summary.solution ?? []).map((pos, i) => (
          <li key={pos} className={`order-item ${summary.correct?.[i] ? "ok" : "bad"}`}>
            <span className="rank">{i + 1}</span>
            <span className="label">
              {label(pos)}
              {summary.order && !summary.correct?.[i] && <s>you put {label(summary.order[i])}</s>}
            </span>
            {summary.values && <span className="value">{formatValue(summary.values[pos], summary.unit ?? "")}</span>}
            <span className="verdict" style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>
              {summary.correct?.[i] ? "✓" : "✗"}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}
