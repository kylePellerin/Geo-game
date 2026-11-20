-- Phase 4: scoring details on answers (instant + final, PLAN.md §6), retry counter for
-- unrecognised input, and lookup indexes.
ALTER TABLE answers
    ADD COLUMN tier text,                       -- famous | well_known | familiar | obscure | rarest
    ADD COLUMN share double precision,          -- estimated share when answered (instant)
    ADD COLUMN final_points integer,            -- after the nightly finalise job
    ADD COLUMN final_tier text,
    ADD COLUMN final_share double precision,
    ADD COLUMN status text NOT NULL DEFAULT 'valid',  -- valid | real_but_wrong | unrecognised
    ADD COLUMN kind text NOT NULL DEFAULT 'free_text',
    ADD COLUMN detail jsonb NOT NULL DEFAULT '{}';    -- matching pairs, namesakes, etc.

CREATE INDEX answers_date_idx_idx ON answers (date, idx);
CREATE INDEX answers_player_date_idx ON answers (player_id, date);

ALTER TABLE answers
    ADD CONSTRAINT answers_player_fk FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;

-- Unrecognised input doesn't use up the question straight away (see app/lib/game/answer.ts).
CREATE TABLE answer_attempts (
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    date date NOT NULL,
    idx smallint NOT NULL,
    n integer NOT NULL DEFAULT 0,
    PRIMARY KEY (player_id, date, idx)
);

-- Final day totals per player, written by the finalise job (leaderboards, percentiles).
CREATE TABLE daily_scores (
    date date NOT NULL,
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    instant_points integer NOT NULL,
    final_points integer,
    finished boolean NOT NULL DEFAULT false,
    PRIMARY KEY (date, player_id)
);
CREATE INDEX daily_scores_date_final_idx ON daily_scores (date, final_points DESC);
