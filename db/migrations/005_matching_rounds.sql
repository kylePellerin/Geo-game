-- Matching rounds (PLAN.md §1): kind = 'free_text' | 'match'. For 'match', valid_entity_ids holds
-- the four left items and payload holds the secret pairs + the shuffled right-hand order.
ALTER TABLE puzzle_questions
    ADD COLUMN kind text NOT NULL DEFAULT 'free_text' CHECK (kind IN ('free_text', 'match')),
    ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
