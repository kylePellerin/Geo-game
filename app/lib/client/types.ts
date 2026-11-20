/** JSON shapes the browser receives from the game API (see app/api/* and PLAN.md §7). */
import type { Tier } from "../game/scoring";

export type { Tier };

export type Kind = "free_text" | "match" | "order";

export interface Named {
  id: string;
  name: string;
  partOf?: string;
}

export interface PlayState {
  state: "not_started" | "playing" | "done";
  startedAt?: string;
  deadline?: string;
  seconds: number;
}

/** A question as listed in /api/daily: text and items only once started. */
export interface DayQuestion {
  idx: number;
  kind: Kind;
  family: string;
  difficulty: number;
  text?: string;
  answerType?: string;
  left?: { pos: number; label?: string; image?: string }[];
  right?: { pos: number; label: string }[];
  items?: { pos: number; label: string }[];
  play: PlayState;
  points: number;
}

/** The question itself, as returned by /api/question/start. */
export interface Question {
  idx: number;
  kind: Kind;
  text: string;
  family: string;
  answerType: string;
  left?: { pos: number; label?: string; image?: string }[];
  right?: { pos: number; label: string }[];
  items?: { pos: number; label: string }[];
}

export interface Daily {
  date: string;
  isToday: boolean;
  serverNow: string;
  questions: DayQuestion[];
}

export interface GivenAnswer {
  entity: Named;
  status: "valid" | "real_but_wrong";
  points: number;
  tier?: Tier;
  share?: number;
}

export interface Summary {
  idx: number;
  points: number;
  answers: GivenAnswer[];
  commonAnswers?: Named[];
  rareAnswers?: Named[];
  fact?: { name: string; text: string };
  pairs?: number[];
  order?: number[];
  correct?: boolean[];
  solution?: number[];
  values?: number[];
  unit?: string;
  dayComplete?: { total: number };
}

export interface StartResponse {
  question: Question;
  play: PlayState;
  serverNow: string;
  answers: GivenAnswer[];
  summary?: Summary;
}

export interface AnswerResponse {
  status: "valid" | "real_but_wrong" | "unrecognised" | "did_you_mean" | "duplicate";
  entity?: Named;
  suggestion?: Named;
  alternative?: Named;
  otherType?: string;
  points: number;
  tier?: Tier;
  share?: number;
  questionPoints: number;
}

export interface DayResults {
  date: string;
  questions: {
    idx: number; kind: Kind; text?: string; family: string; state: PlayState["state"];
    points: number; finalPoints?: number;
    answers: { name: string; status: string; points: number; tier?: Tier; share?: number }[];
    correctPairs?: number; pairCount?: number;
  }[];
  total: number;
  finalTotal: number | null;
  finished: boolean;
  percentile: number | null;
  shareText: string;
}

export interface ApiError {
  error: string;
  message: string;
}
