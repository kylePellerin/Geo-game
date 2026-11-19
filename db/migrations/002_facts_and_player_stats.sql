ALTER TABLE relations
    ADD COLUMN attrs jsonb NOT NULL DEFAULT '{}';

CREATE TABLE entity_facts (
    entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    context text NOT NULL,
    text text NOT NULL,
    reviewed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (entity_id, context)
);

CREATE TABLE players (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    account_user_id uuid
);

CREATE TABLE player_stats (
    player_id uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    games_played integer NOT NULL DEFAULT 0,
    current_streak integer NOT NULL DEFAULT 0,
    max_streak integer NOT NULL DEFAULT 0,
    last_played_date date,
    best_score integer,
    best_score_date date,
    total_points bigint NOT NULL DEFAULT 0,
    hundred_point_answers integer NOT NULL DEFAULT 0,
    rarest_answer_entity_id text REFERENCES entities(id) ON DELETE SET NULL,
    rarest_answer_share double precision,
    rarest_answer_date date,
    score_histogram jsonb NOT NULL DEFAULT '{}',
    family_stats jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfer_codes (
    code text PRIMARY KEY CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);

CREATE INDEX transfer_codes_player_id_idx ON transfer_codes(player_id);
