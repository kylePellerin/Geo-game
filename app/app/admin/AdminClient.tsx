"use client";
/**
 * The admin app: a calendar of upcoming days, a day editor (six slots) and a question builder
 * for writing questions by hand. Everything goes through /api/admin/action.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { DayQuestionDetail } from "@/lib/game/admin";

interface Ent { id: string; name: string; country: string | null; type?: string }
interface CalDay { date: string; n: number; custom: number; reviewed: boolean; answered: boolean }
interface Day { exists: boolean; reviewed: boolean; hasAnswers: boolean; today: string; questions: DayQuestionDetail[] }
interface Unmatched { date: string; idx: number; question: string; entityType: string; raw: string; n: number }

async function post<T>(body: object): Promise<T> {
  const res = await fetch("/api/admin/action", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.message ?? "failed");
  return json as T;
}


const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
/** Locale-free date parts (server and browser must render the same text). */
function parts(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  return { wd: DAYS[d.getUTCDay()], day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()], year: d.getUTCFullYear() };
}

/** Default player-facing category for an answer type. */
const TYPE_FAMILY: Record<string, string> = {
  country: "countries", city: "cities", region: "regions", airport: "airports", mountain: "mountains",
  river: "water", lake: "water", island: "islands", landmark: "landmarks", animal: "symbols",
};
const KIND_LABEL: Record<string, string> = { free_text: "Free text", match: "Matching", order: "Ordering" };
const SLOT_HINT = ["easy", "easy", "easy", "matching", "medium / ordering", "hard"];

export function AdminApp({ today, unmatched, families, types, continents }: {
  today: string; unmatched: Unmatched[]; families: Record<string, string>; types: string[]; continents: string[];
}) {
  const [tab, setTab] = useState<"plan" | "aliases">("plan");
  const [cal, setCal] = useState<CalDay[]>([]);
  const [date, setDate] = useState(today);
  const [day, setDay] = useState<Day | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ idx: number; q?: DayQuestionDetail } | null>(null);

  const loadCal = useCallback(() => post<CalDay[]>({ action: "calendar", from: today, days: 35 }).then(setCal), [today]);
  const loadDay = useCallback((d: string) => post<Day>({ action: "day", date: d }).then(setDay), []);
  useEffect(() => { void loadCal(); }, [loadCal]);
  useEffect(() => { setDay(null); void loadDay(date); }, [date, loadDay]);

  async function act(body: object, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ message?: string }>(body);
      setMsg({ text: r.message ?? ok });
      await Promise.all([loadDay(date), loadCal()]);
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  }

  const locked = !!day && (day.hasAnswers || date < today);
  const slots = [0, 1, 2, 3, 4, 5].map((i) => day?.questions.find((q) => q.idx === i));

  return (
    <main className="admin">
      <div className="admin-top">
        <h1>Geo<em>rarity</em> admin</h1>
        <div className="admin-tabs">
          <button type="button" aria-pressed={tab === "plan"} onClick={() => setTab("plan")}>Plan days</button>
          <button type="button" aria-pressed={tab === "aliases"} onClick={() => setTab("aliases")}>
            Unrecognised answers ({unmatched.length})
          </button>
          <Link className="btn btn-ink" href="/" style={{ padding: "0.3rem 0.9rem" }}>Play ↗</Link>
        </div>
      </div>

      {tab === "plan" && (
        <>
          <div className="cal" role="list" aria-label="Upcoming days">
            {cal.map((c) => {
              const d = parts(c.date);
              return (
                <button key={c.date} type="button" aria-pressed={c.date === date} onClick={() => setDate(c.date)}
                        aria-label={`${c.date}: ${c.n} questions`}>
                  <span className="flags">{c.answered ? "🔒" : c.reviewed ? "✓" : ""}</span>
                  {d.wd.slice(0, 3)}
                  <span className="d">{d.day} {d.month.slice(0, 3)}</span>
                  <span className="bar">
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <i key={i} className={i < c.custom ? "custom" : i < c.n ? "on" : ""} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="admin-top">
            <h2 style={{ fontFamily: "var(--font-display)", margin: 0 }}>
              {(({ wd, day, month, year }) => `${wd} ${day} ${month} ${year}`)(parts(date))}
              {date === today && " · today"}
            </h2>
            {day && !locked && (
              <div className="btn-row" style={{ marginTop: 0 }}>
                <button type="button" className="btn btn-gold" disabled={busy}
                        onClick={() => act({ action: "generate", date }, "generated")}>
                  {day.questions.length ? "Regenerate the rest" : "Auto-fill this day"}
                </button>
                {day.exists && (
                  <button type="button" className="btn btn-ink" disabled={busy}
                          onClick={() => act({ action: "review", date, reviewed: !day.reviewed }, "saved")}>
                    {day.reviewed ? "✓ Reviewed" : "Mark reviewed"}
                  </button>
                )}
              </div>
            )}
          </div>
          {locked && <p className="msg err">🔒 This day {date < today ? "is in the past" : "has been played"}; it&apos;s frozen.</p>}
          {msg && <p className={`msg ${msg.err ? "err" : ""}`} role="status">{msg.text}</p>}
          {busy && <p className="msg">Working… (the generator can take a minute)</p>}
          {day && day.questions.length > 0 && day.questions.length < 6 && (
            <p className="msg err">This day has {day.questions.length} of 6 questions; fill the empty slots before it goes live.</p>
          )}

          <div className="slots">
            {slots.map((q, i) => q ? (
              <div key={i} className="card slot">
                <div className="slot-head">
                  <span className="n">{i + 1}</span>
                  <span className="badge">{KIND_LABEL[q.kind]}</span>
                  <span className="badge">{families[q.family] ?? q.family}</span>
                  <span className="badge">difficulty {q.difficulty}</span>
                  {q.custom ? <span className="badge custom">hand-written</span> : <span className="badge">{q.templateId}</span>}
                </div>
                <SlotText q={q} locked={locked} onSave={(text) => act({ action: "text", date, idx: i, text }, "wording saved")} />
                <SlotAnswers q={q} />
                {!locked && (
                  <div className="actions">
                    <button type="button" className="btn" onClick={() => setEditing({ idx: i, q })}>Write my own</button>
                    <button type="button" className="btn btn-ghost" disabled={busy}
                            onClick={() => act({ action: "replace", date, idx: i }, "replaced")}>Auto-replace</button>
                    <button type="button" className="btn btn-ghost" disabled={busy}
                            onClick={() => { if (confirm(`Empty slot ${i + 1}?`)) void act({ action: "clear", date, idx: i }, "cleared"); }}>Clear</button>
                  </div>
                )}
              </div>
            ) : (
              <div key={i} className="card slot empty">
                <div className="slot-head"><span className="n">{i + 1}</span><span className="badge">empty · usually {SLOT_HINT[i]}</span></div>
                {!locked && day && (
                  <div className="actions">
                    <button type="button" className="btn" onClick={() => setEditing({ idx: i })}>Write a question</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {editing && (
            <Builder date={date} idx={editing.idx} initial={editing.q} today={today} families={families}
                     types={types} continents={continents}
                     onClose={() => setEditing(null)}
                     onSaved={async () => {
                       setEditing(null);
                       setMsg({ text: `Slot ${editing.idx + 1} saved` });
                       await Promise.all([loadDay(date), loadCal()]);
                     }} />
          )}
        </>
      )}

      {tab === "aliases" && <Aliases rows={unmatched} />}
    </main>
  );
}

function SlotText({ q, locked, onSave }: { q: DayQuestionDetail; locked: boolean; onSave: (t: string) => void }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(q.text);
  useEffect(() => setText(q.text), [q.text]);
  if (!edit) {
    return (
      <h3>
        {q.text}{" "}
        {!locked && <button type="button" className="btn btn-ghost" style={{ fontSize: "0.75rem", padding: "0.1em 0.6em" }}
                            onClick={() => setEdit(true)}>edit wording</button>}
      </h3>
    );
  }
  return (
    <div className="row" style={{ margin: "0.4rem 0" }}>
      <input className="admin-input" style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Question text" />
      <button type="button" className="btn" onClick={() => { onSave(text); setEdit(false); }}>Save</button>
      <button type="button" className="btn btn-ghost" onClick={() => { setText(q.text); setEdit(false); }}>Cancel</button>
    </div>
  );
}

function SlotAnswers({ q }: { q: DayQuestionDetail }) {
  const [all, setAll] = useState(false);
  if (q.pairs) {
    return <div className="answers">{q.pairs.map((p, i) => <div key={i}><b>{p.leftLabel}</b> → {p.rightLabel} <small>({p.category})</small></div>)}
      {q.display !== "names" && <div><small>shown as {q.display}</small></div>}</div>;
  }
  if (q.items) {
    return <div className="answers">Right order: {q.items.map((it, i) => <span key={i}>{i ? " › " : ""}<b>{it.label}</b> ({it.value} {q.unit})</span>)}</div>;
  }
  const answers = q.answers ?? [];
  const shown = all ? answers : answers.slice(0, 14);
  return (
    <div className="answers">
      <b>{answers.length} right answers</b>, most famous first: {shown.map((a) => a.name).join(", ")}
      {answers.length > shown.length && <> … <button type="button" className="btn btn-ghost" style={{ fontSize: "0.75rem", padding: "0 0.6em" }} onClick={() => setAll(true)}>show all</button></>}
    </div>
  );
}

// ------------------------------------------------------------------ builder

function EntitySearch({ type, onPick, placeholder }: { type: string; onPick: (e: Ent) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Ent[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => { post<Ent[]>({ action: "search", type, q }).then(setHits, () => setHits([])); }, 220);
    return () => clearTimeout(t);
  }, [q, type]);
  return (
    <div>
      <input className="admin-input" style={{ width: "100%" }} value={q} placeholder={placeholder ?? "Search…"}
             onChange={(e) => setQ(e.target.value)} aria-label={placeholder ?? "Search"} />
      {hits.length > 0 && (
        <div className="hits">
          {hits.map((h) => (
            <button key={h.id} type="button" onClick={() => { onPick(h); setQ(""); setHits([]); }}>
              {h.name}{h.country ? ` · ${h.country}` : ""}{type === "" && h.type ? ` · ${h.type}` : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Builder({ date, idx, initial, today, families, types, continents, onClose, onSaved }: {
  date: string; idx: number; initial?: DayQuestionDetail; today: string; families: Record<string, string>;
  types: string[]; continents: string[]; onClose: () => void; onSaved: () => void;
}) {
  const startKind = (initial?.kind ?? (idx === 3 ? "match" : "free_text")) as "free_text" | "match" | "order";
  const [kind, setKind] = useState(startKind);
  const [text, setText] = useState(initial?.custom ? initial.text : "");
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? (idx < 3 ? 1 : idx === 5 ? 3 : 2));
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // free text
  const [etype, setEtype] = useState(initial?.kind === "free_text" ? initial.entityType : "country");
  const [family, setFamily] = useState(initial?.kind === "free_text" && initial.family !== "custom" ? initial.family : "countries");
  const [answers, setAnswers] = useState<Ent[]>(initial?.kind === "free_text" && initial.custom ? initial.answers ?? [] : []);
  const [paste, setPaste] = useState("");
  const [missing, setMissing] = useState<{ text: string; suggestions: Ent[] }[]>([]);
  const [continent, setContinent] = useState("");
  const [country, setCountry] = useState<Ent | null>(null);
  // matching
  const [display, setDisplay] = useState<"names" | "flags" | "outlines" | "maps">(
    (initial?.display as "names" | "flags" | "outlines" | "maps") ?? "names");
  const [pairs, setPairs] = useState<{ left: Ent | null; rightLabel: string; category: string }[]>(
    initial?.pairs && initial.custom
      ? initial.pairs.map((p) => ({ left: { id: p.left, name: p.leftLabel, country: null }, rightLabel: p.rightLabel, category: p.category }))
      : ["well_known", "familiar", "familiar", "obscure"].map((category) => ({ left: null, rightLabel: "", category })));
  const [decoys, setDecoys] = useState<string[]>(() => {
    const d = initial?.decoys ?? [];
    return [d[0] ?? "", d[1] ?? ""];
  });
  // ordering
  const [unit, setUnit] = useState(initial?.unit ?? "");
  const [direction, setDirection] = useState(initial?.direction ?? "desc");
  const [items, setItems] = useState<{ label: string; value: string }[]>(
    initial?.items && initial.custom ? initial.items.map((it) => ({ label: it.label, value: String(it.value) }))
      : Array.from({ length: 5 }, () => ({ label: "", value: "" })));

  const addAnswers = (es: Ent[]) => setAnswers((cur) => {
    const seen = new Set(cur.map((e) => e.id));
    return [...cur, ...es.filter((e) => !seen.has(e.id) && seen.add(e.id))];
  });

  async function resolve() {
    try {
      const r = await post<{ found: Ent[]; missing: { text: string; suggestions: Ent[] }[] }>(
        { action: "resolve", type: etype, lines: paste.split(/[\n,;]+/) });
      addAnswers(r.found);
      setMissing(r.missing);
      setPaste(r.missing.map((m) => m.text).join("\n"));
    } catch (e) { setErr((e as Error).message); }
  }

  async function addWhere() {
    try {
      addAnswers(await post<Ent[]>({ action: "where", type: etype, continent: continent || undefined, country_id: country?.id }));
    } catch (e) { setErr((e as Error).message); }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    const question = kind === "free_text"
      ? { kind, text, difficulty, entityType: etype, family, answerIds: answers.map((a) => a.id) }
      : kind === "match"
        ? { kind, text, difficulty, display, pairs: pairs.map((p) => ({ left: p.left?.id ?? "", rightLabel: p.rightLabel, category: p.category })),
            decoys: decoys.filter((d) => d.trim()) }
        : { kind, text, difficulty, unit, direction, items: items.filter((it) => it.label.trim()).map((it) => ({ label: it.label, value: Number(it.value.replace(/[, ]/g, "")) })) };
    try {
      await post({ action: "save", date, idx, question });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="card sheet builder" role="dialog" aria-modal="true" aria-label="Question builder"
           onClick={(e) => e.stopPropagation()} style={{ maxWidth: "52rem" }}>
        <h2>{date} · slot {idx + 1}{date === today ? " (today!)" : ""}</h2>
        <div className="admin-tabs" style={{ marginBottom: "0.9rem" }}>
          {(["free_text", "match", "order"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                    style={kind === k ? undefined : { color: "var(--text)", borderColor: "rgba(28,26,22,.3)" }}>{KIND_LABEL[k]}</button>
          ))}
        </div>
        <label className="field">
          <span>Question text</span>
          <input value={text} onChange={(e) => setText(e.target.value)}
                 placeholder={kind === "free_text" ? "Name a volcano in Asia" : kind === "match" ? "Match each country to its capital" : "Order these rivers by length, longest first"} />
        </label>
        <div className="row">
          <label className="field">
            <span>Difficulty</span>
            <select value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))}>
              <option value={1}>1 · easy</option><option value={2}>2 · medium</option><option value={3}>3 · hard</option>
            </select>
          </label>
          {kind === "free_text" && (
            <>
              <label className="field">
                <span>Answers are</span>
                <select value={etype} onChange={(e) => {
                  setEtype(e.target.value);
                  setAnswers([]);
                  if (TYPE_FAMILY[e.target.value]) setFamily(TYPE_FAMILY[e.target.value]);
                }}>
                  {types.map((t) => <option key={t} value={t}>{t}s</option>)}
                </select>
              </label>
              <label className="field">
                <span>Category (shown to players)</span>
                <select value={family} onChange={(e) => setFamily(e.target.value)}>
                  {Object.entries(families).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            </>
          )}
          {kind === "match" && (
            <label className="field">
              <span>Left side shows</span>
              <select value={display} onChange={(e) => setDisplay(e.target.value as typeof display)}>
                <option value="names">names</option><option value="flags">flags (countries)</option><option value="outlines">outlines (countries)</option><option value="maps">pixel maps (countries)</option>
              </select>
            </label>
          )}
          {kind === "order" && (
            <>
              <label className="field"><span>Unit</span><input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="km, people, m, year" /></label>
              <label className="field">
                <span>First in the list</span>
                <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                  <option value="desc">largest value</option><option value="asc">smallest value</option>
                </select>
              </label>
            </>
          )}
        </div>

        {kind === "free_text" && (
          <>
            <div className="field">
              <span>Right answers ({answers.length}) · click one to remove</span>
              <div className="chips">
                {answers.length === 0 && <small style={{ color: "var(--text-soft)" }}>None yet: add some below.</small>}
                {answers.map((a) => (
                  <button key={a.id} type="button" title="remove" onClick={() => setAnswers((cur) => cur.filter((x) => x.id !== a.id))}>
                    {a.name}{a.country && etype !== "country" ? ` · ${a.country}` : ""}
                  </button>
                ))}
              </div>
              {answers.length > 0 && <div><button type="button" className="btn btn-ghost" style={{ fontSize: "0.75rem", padding: "0.1em 0.6em", marginTop: "0.3rem" }} onClick={() => setAnswers([])}>remove all</button></div>}
            </div>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div className="field" style={{ flex: 1, minWidth: "14rem" }}>
                <span>Add one</span>
                <EntitySearch type={etype} onPick={(e) => addAnswers([e])} placeholder={`Search ${etype}s…`} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: "14rem" }}>
                <span>Add every {etype} in…</span>
                <div className="row" style={{ alignItems: "center" }}>
                  <select className="admin-input" value={continent} onChange={(e) => setContinent(e.target.value)} aria-label="Continent">
                    <option value="">any continent</option>
                    {continents.map((c) => <option key={c}>{c}</option>)}
                  </select>
                  {country
                    ? <span className="picked">{country.name}<button type="button" onClick={() => setCountry(null)}>✕</button></span>
                    : etype !== "country" && <div style={{ flex: 1 }}><EntitySearch type="country" onPick={setCountry} placeholder="…or a country" /></div>}
                  <button type="button" className="btn btn-ink" onClick={addWhere} disabled={!continent && !country}>Add</button>
                </div>
              </div>
            </div>
            <label className="field">
              <span>Or paste names (one per line or comma-separated)</span>
              <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"Mount Fuji\nKrakatoa\nMount Pinatubo"} />
            </label>
            <button type="button" className="btn btn-ink" onClick={resolve} disabled={!paste.trim()}>Find these</button>
            {missing.length > 0 && (
              <div className="msg err">
                Not found: {missing.map((m) => (
                  <span key={m.text}>“{m.text}”{m.suggestions.length > 0 && <> (maybe {m.suggestions.map((s) => (
                    <button key={s.id} type="button" className="btn btn-ghost" style={{ fontSize: "0.75rem", padding: "0 0.5em", margin: "0 0.15em" }}
                            onClick={() => { addAnswers([s]); setMissing((ms) => ms.filter((x) => x !== m)); }}>{s.name}{s.country ? ` · ${s.country}` : ""}</button>
                  ))})</>} </span>
                ))}
              </div>
            )}
          </>
        )}

        {kind === "match" && (
          <>
            <div className="pair-row" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", textTransform: "uppercase", color: "var(--text-soft)" }}>
              <span>Left item ({display === "names" ? "any place" : "country"})</span><span>Its match (text)</span><span>How well known</span>
            </div>
            {pairs.map((p, i) => (
              <div key={i} className="pair-row">
                {p.left
                  ? <span className="picked">{p.left.name}<button type="button" onClick={() => setPairs((ps) => ps.map((x, j) => j === i ? { ...x, left: null } : x))}>✕</button></span>
                  : <EntitySearch type={display === "names" ? "" : "country"} placeholder={`Item ${i + 1}…`}
                                  onPick={(e) => setPairs((ps) => ps.map((x, j) => j === i ? { ...x, left: e } : x))} />}
                <input className="admin-input" value={p.rightLabel} aria-label={`Match ${i + 1}`}
                       onChange={(e) => setPairs((ps) => ps.map((x, j) => j === i ? { ...x, rightLabel: e.target.value } : x))} />
                <select className="admin-input" value={p.category} aria-label={`Rarity ${i + 1}`}
                        onChange={(e) => setPairs((ps) => ps.map((x, j) => j === i ? { ...x, category: e.target.value } : x))}>
                  <option value="famous">famous (10)</option><option value="well_known">well known (15)</option>
                  <option value="familiar">familiar (25)</option><option value="obscure">obscure (35)</option><option value="rarest">rarest (40)</option>
                </select>
              </div>
            ))}
            <div className="pair-row">
              <span>Options that match nothing</span>
              {decoys.map((d, i) => (
                <input key={i} className="admin-input" value={d} aria-label={`Extra option ${i + 1}`} placeholder="optional"
                       onChange={(e) => setDecoys((ds) => ds.map((x, j) => j === i ? e.target.value : x))} />
              ))}
            </div>
            <p className="hint">Players see the matches shuffled with the extra options (4 pairs; 3 also works). Make one of them a little obscure, and make the extras believable.</p>
          </>
        )}

        {kind === "order" && (
          <>
            {items.map((it, i) => (
              <div key={i} className="order-row">
                <input className="admin-input" value={it.label} placeholder={`Item ${i + 1}`} aria-label={`Item ${i + 1}`}
                       onChange={(e) => setItems((xs) => xs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
                <input className="admin-input" value={it.value} placeholder="value" inputMode="decimal" aria-label={`Value ${i + 1}`}
                       onChange={(e) => setItems((xs) => xs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                <button type="button" className="btn btn-ghost" onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))} disabled={items.length <= 3}>✕</button>
              </div>
            ))}
            {items.length < 6 && <button type="button" className="btn btn-ghost" onClick={() => setItems((xs) => [...xs, { label: "", value: "" }])}>+ item</button>}
            <p className="hint">Type items in any order: they&apos;re shuffled for players and sorted by value for the answer.</p>
          </>
        )}

        {err && <p className="msg err" role="alert">{err}</p>}
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={save} disabled={saving}>{saving ? "Saving…" : `Save to slot ${idx + 1}`}</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ aliases

function Aliases({ rows }: { rows: Unmatched[] }) {
  return (
    <div className="card">
      <p className="hint" style={{ marginTop: 0 }}>Most frequent first. Add an alias so the matcher recognises the text next time.</p>
      <table className="unmatched">
        <thead><tr><th>n</th><th>Text</th><th>Question</th><th>Add as an alias of…</th></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={`${u.date}-${u.idx}-${u.raw}`}>
              <td>{u.n}</td>
              <td><b>{u.raw}</b></td>
              <td><small>{u.date} #{u.idx + 1}: {u.question}</small></td>
              <td><AliasForm type={u.entityType} raw={u.raw} /></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4}>Nothing yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AliasForm({ type, raw }: { type: string; raw: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  if (msg) return <small>{msg}</small>;
  return (
    <EntitySearch type={type} placeholder={`find the ${type}…`} onPick={async (h) => {
      try {
        await post({ action: "alias", entity_id: h.id, alias: raw });
        setMsg(`“${raw}” → ${h.name}`);
      } catch (e) { setMsg((e as Error).message); }
    }} />
  );
}
