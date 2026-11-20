/**
 * Per-player cache in localStorage so results and finished questions show instantly (user
 * request 2026-11-20). Everything here is the player's own data the server already sent them;
 * the server stays the source of truth and the screens revalidate in the background.
 * Keys carry the player id and date, so a shared browser or a transferred identity never shows
 * someone else's day. Old days are pruned.
 */
import type { DayQuestion, DayResults, Kind, Summary } from "./types";

const PREFIX = "gr_c:";
const KEEP_DAYS = 14;

function playerId(): string | null {
  try {
    return localStorage.getItem("gr_pid");
  } catch {
    return null;
  }
}

function key(kind: "res" | "sum", date: string): string | null {
  const pid = playerId();
  return pid ? `${PREFIX}${kind}:${pid}:${date}` : null;
}

function read<T>(k: string | null): T | null {
  if (!k) return null;
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(k: string | null, value: unknown): void {
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the cache is only a convenience */
  }
}

export const cachedResults = (date: string) => read<DayResults>(key("res", date));
export const storeResults = (date: string, r: DayResults) => write(key("res", date), r);

export function cachedSummaries(date: string): Map<number, Summary> {
  const obj = read<Record<string, Summary>>(key("sum", date)) ?? {};
  return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
}

export function storeSummary(date: string, s: Summary): void {
  const k = key("sum", date);
  const obj = read<Record<string, Summary>>(k) ?? {};
  // dayComplete is a one-off signal, not part of the summary
  const rest = { ...s };
  delete rest.dayComplete;
  obj[s.idx] = rest;
  write(k, obj);
}

/** Drop cache entries older than KEEP_DAYS. */
export function pruneCache(today: string): void {
  try {
    const cutoff = new Date(Date.parse(today) - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX) && k.slice(-10) < cutoff) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Results built from what the game screen already knows, so the end screen can render the moment
 * the last question ends; the server's version (percentile, share text) replaces it on arrival.
 */
export function localResults(
  date: string, questions: (DayQuestion & { text?: string })[], summaries: Map<number, Summary>,
): DayResults {
  const qs = questions.map((q) => {
    const s = summaries.get(q.idx);
    const kind: Kind = q.kind;
    const pairCount = kind === "match" ? (q.left?.length ?? 4) : kind === "order" ? (q.items?.length ?? 5) : undefined;
    return {
      idx: q.idx, kind, text: q.text, family: q.family, state: q.play.state, points: q.points,
      answers: (s?.answers ?? []).map((a) => ({
        name: a.entity.name, status: a.status, points: a.points,
        ...(a.tier ? { tier: a.tier } : {}), ...(a.share !== undefined ? { share: a.share } : {}),
      })),
      ...(pairCount !== undefined
        ? { pairCount, correctPairs: s?.correct?.filter(Boolean).length ?? 0 } : {}),
    };
  });
  const total = qs.reduce((n, q) => n + q.points, 0);
  return {
    date, questions: qs, total, finalTotal: null,
    finished: qs.every((q) => q.state === "done"), percentile: null, shareText: "",
  };
}
