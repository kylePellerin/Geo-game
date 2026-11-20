-- One correct answer per question (rules of 2026-11-20, second playtest): wrong answers may be
-- retried, but the first valid answer is final and ends the question.
-- Also: templates for questions written by hand in the admin.

DELETE FROM answers a USING answers b
WHERE a.kind = 'free_text' AND b.kind = 'free_text' AND a.valid AND b.valid
  AND a.player_id = b.player_id AND a.date = b.date AND a.idx = b.idx AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS answers_one_valid
  ON answers (player_id, date, idx) WHERE kind = 'free_text' AND valid;

INSERT INTO question_templates (id, kind, entity_type, text_pattern, sql_or_filter, min_answers,
                                difficulty, family)
SELECT v.id, v.kind, 'any', 'written in the admin', 'hand-picked answers', 1, 2, 'custom'
FROM (VALUES ('custom_free_text', 'membership'), ('custom_match', 'matching'),
             ('custom_order', 'ordering')) AS v(id, kind)
ON CONFLICT (id) DO NOTHING;
