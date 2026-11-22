/** JSON shapes the browser receives from the game API (see app/api/* and PLAN.md §7). */
import type { Tier } from "../game/scoring";

export type { Tier };

export type Kind = "free_text" | "match" | "order";

export interface Named {
  id: string;
  name: string;
  partOf?: string;
  /** set for dependent territories (Greenland: "Denmark"; Western Sahara: "no country") */
  territoryOf?: string;
  /** [lat, lon] of the player's own answer, for the map */
  at?: [number, number];
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
  left?: { pos: number; label?: string; image?: string; picture?: "flag" | "outline" | "map" }[];
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
  /** e.g. "Territories (like Puerto Rico) count too" */
  hint?: string;
  left?: { pos: number; label?: string; image?: string; picture?: "flag" | "outline" | "map" }[];
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
  /** a correct answer ends the question: here's its summary */
  summary?: Summary;
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

export interface PlayerStatsView {
  gamesPlayed: number;
  currentStreak: number;
  maxStreak: number;
  bestScore: number | null;
  bestScoreDate: string | null;
  average: number;
  hundredPointAnswers: number;
  rarestAnswer: { name: string; share: number; date: string | null } | null;
  histogram: { from: number; n: number }[];
  bestFamily: { family: string; n: number; avg: number } | null;
  worstFamily: { family: string; n: number; avg: number } | null;
  todayPercentile: number | null;
}

export interface StatsResponse {
  /** the player's leaderboard name */
  name: string;
  stats: PlayerStatsView | null;
}

export interface LeaderRow { rank: number; name: string; points: number; you: boolean }
export interface LeaderboardResponse {
  date: string;
  players: number;
  final: boolean;
  top: LeaderRow[];
  you: LeaderRow | null;
}

export interface PracticeNext {
  question: Question;
  seconds: number;
  difficulty: number;
}
