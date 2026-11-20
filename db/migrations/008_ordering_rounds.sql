-- Ordering rounds (2026-11-20): put five items in order. valid_entity_ids = items in display
-- order; payload = {variant, direction, unit, items[{id,label,value}], answer[]} (secret).
ALTER TABLE puzzle_questions DROP CONSTRAINT puzzle_questions_kind_check;
ALTER TABLE puzzle_questions ADD CONSTRAINT puzzle_questions_kind_check
    CHECK (kind IN ('free_text', 'match', 'order'));
DROP INDEX answers_one_match;
-- one submission per matching/ordering round
CREATE UNIQUE INDEX answers_one_round ON answers (player_id, date, idx) WHERE kind IN ('match', 'order');
