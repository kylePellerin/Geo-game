-- Phase 7 (retention): transfer-code claims are rate limited in the database (serverless
-- instances don't share memory), and practice questions get their own pool.

CREATE TABLE claim_attempts (
    key text NOT NULL,              -- "ip:<address>" or "player:<uuid>"
    at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_attempts_key_at_idx ON claim_attempts (key, at);

-- Practice mode: questions anyone can replay at any time. Never scored, never counted in the
-- daily answer counts. Filled by geo_pipeline.generate_practice from the same templates as the
-- daily puzzles (frozen answer sets, like daily ones), plus finished daily questions.
CREATE TABLE practice_questions (
    id serial PRIMARY KEY,
    template_id text NOT NULL,
    params jsonb NOT NULL DEFAULT '{}',
    question_text text NOT NULL,
    valid_entity_ids text[] NOT NULL,
    family text NOT NULL,
    entity_type text NOT NULL,
    difficulty smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
    kind text NOT NULL DEFAULT 'free_text' CHECK (kind IN ('free_text', 'match', 'order')),
    payload jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (template_id, params)
);
