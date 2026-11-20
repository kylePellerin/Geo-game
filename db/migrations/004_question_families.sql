-- Question family (QUESTIONS.md §3) on templates, and frozen copies on each puzzle question so
-- editing a template later never changes a past puzzle.
ALTER TABLE question_templates ADD COLUMN family text NOT NULL DEFAULT 'misc';

ALTER TABLE puzzle_questions
    ADD COLUMN family text NOT NULL DEFAULT 'misc',
    ADD COLUMN entity_type text NOT NULL DEFAULT 'country',
    ADD COLUMN difficulty smallint NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 3),
    ADD COLUMN stats jsonb NOT NULL DEFAULT '{}';  -- generation-time stats (answer counts, floor)
