-- Timed questions with several answers each (decided 2026-11-20, PLAN.md §1):
-- a player starts a question, then has a fixed number of seconds to give as many answers as they
-- like. question_plays holds the timer; answers gets one row per distinct entity given.
CREATE TABLE question_plays (
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    date date NOT NULL,
    idx smallint NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    deadline timestamptz NOT NULL,
    ended_at timestamptz,                -- set by "I'm done", a matching submit, or on expiry
    PRIMARY KEY (player_id, date, idx),
    FOREIGN KEY (date, idx) REFERENCES puzzle_questions(date, idx) ON DELETE CASCADE
);
CREATE INDEX question_plays_date_idx_idx ON question_plays (date, idx);

ALTER TABLE answers DROP CONSTRAINT answers_player_id_date_idx_key;
-- the same place counts once per question; a matching round is one submission
CREATE UNIQUE INDEX answers_one_entity ON answers (player_id, date, idx, matched_entity_id)
    WHERE matched_entity_id IS NOT NULL;
CREATE UNIQUE INDEX answers_one_match ON answers (player_id, date, idx) WHERE kind = 'match';

DROP TABLE answer_attempts;
