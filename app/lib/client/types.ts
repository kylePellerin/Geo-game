/** JSON shapes the browser receives from the game API (see app/api/* and PLAN.md §7). */
import type { Tier } from "../game/scoring";

export type { Tier };

export interface Named {
  id: string;
  name: string;
}

export interface Question {
  idx: number;
  kind: "free_text" | "match";
  text: string;
  family: string;
  answerType: string;
  left?: { pos: number; label?: string; image?: string }[];
  right?: { pos: number; label: string }[];
}

export interface Progress {
  idx: number;
  status?: string;
  points: number;
  answer?: string;
  tier?: Tier;
}

export interface Daily {
  date: string;
  isToday: boolean;
  questions: Question[];
  progress: Progress[];
}

export interface AnswerResponse {
  status: "valid" | "real_but_wrong" | "unrecognised" | "did_you_mean" | "match";
  final: boolean;
  already_answered: boolean;
  entity?: Named & { partOf?: string };
  suggestion?: Named;
  alternative?: Named;
  other_type?: string;
  attempts_left?: number;
  points: number;
  tier?: Tier;
  share?: number;
  common_answers?: Named[];
  rare_answers?: Named[];
  correct?: boolean[];
  solution?: number[];
  day_complete?: { total: number };
}

export interface DayResults {
  date: string;
  questions: {
    idx: number; text: string; family: string; answered: boolean; status?: string;
    answer?: string; points: number; finalPoints?: number; tier?: Tier; share?: number;
    correctPairs?: number;
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
