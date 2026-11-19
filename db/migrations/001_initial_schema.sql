CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE entities (
    id text PRIMARY KEY,
    type text NOT NULL,
    name text NOT NULL,
    country_id text REFERENCES entities(id),
    lat double precision,
    lon double precision,
    attrs jsonb NOT NULL DEFAULT '{}',
    popularity double precision,
    sources text[]
);

CREATE INDEX entities_type_idx ON entities(type);
CREATE INDEX entities_country_id_idx ON entities(country_id);

CREATE TABLE aliases (
    entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias text NOT NULL,
    alias_norm text NOT NULL,
    kind text NOT NULL,
    PRIMARY KEY (entity_id, alias_norm, kind)
);

CREATE INDEX aliases_alias_norm_trgm_idx ON aliases USING gin (alias_norm gin_trgm_ops);

CREATE TABLE relations (
    a text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    rel text NOT NULL,
    b text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (a, rel, b)
);

CREATE INDEX relations_b_rel_idx ON relations(b, rel);

CREATE TABLE question_templates (
    id text PRIMARY KEY,
    kind text NOT NULL,
    entity_type text NOT NULL,
    text_pattern text NOT NULL,
    params_schema jsonb NOT NULL DEFAULT '{}',
    sql_or_filter text NOT NULL,
    min_answers integer NOT NULL DEFAULT 10,
    max_answers integer NOT NULL DEFAULT 300,
    difficulty smallint NOT NULL,
    CHECK (min_answers > 0 AND max_answers >= min_answers),
    CHECK (difficulty BETWEEN 1 AND 3)
);

CREATE TABLE daily_puzzles (
    date date PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed boolean NOT NULL DEFAULT false
);

CREATE TABLE puzzle_questions (
    date date NOT NULL REFERENCES daily_puzzles(date) ON DELETE CASCADE,
    idx smallint NOT NULL CHECK (idx BETWEEN 0 AND 5),
    template_id text NOT NULL REFERENCES question_templates(id),
    params jsonb NOT NULL DEFAULT '{}',
    question_text text NOT NULL,
    valid_entity_ids text[] NOT NULL,
    PRIMARY KEY (date, idx)
);

CREATE TABLE answers (
    id bigserial PRIMARY KEY,
    player_id uuid NOT NULL,
    date date NOT NULL,
    idx smallint NOT NULL,
    raw_text text NOT NULL,
    matched_entity_id text REFERENCES entities(id),
    valid boolean NOT NULL,
    points integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (player_id, date, idx),
    FOREIGN KEY (date, idx) REFERENCES puzzle_questions(date, idx)
);

CREATE TABLE answer_counts (
    date date NOT NULL,
    idx smallint NOT NULL,
    entity_id text NOT NULL REFERENCES entities(id),
    n integer NOT NULL CHECK (n >= 0),
    PRIMARY KEY (date, idx, entity_id),
    FOREIGN KEY (date, idx) REFERENCES puzzle_questions(date, idx)
);

CREATE TABLE unmatched_log (
    date date NOT NULL,
    idx smallint NOT NULL,
    raw_text text NOT NULL,
    n integer NOT NULL DEFAULT 1 CHECK (n > 0),
    PRIMARY KEY (date, idx, raw_text),
    FOREIGN KEY (date, idx) REFERENCES puzzle_questions(date, idx)
);
