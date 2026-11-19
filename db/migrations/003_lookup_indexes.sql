-- Exact alias lookup (matcher step 2) and per-entity alias listing.
CREATE INDEX aliases_alias_norm_idx ON aliases (alias_norm);
CREATE INDEX aliases_entity_id_idx ON aliases (entity_id);
-- Template filters over type-specific attributes.
CREATE INDEX entities_attrs_gin_idx ON entities USING gin (attrs jsonb_path_ops);
CREATE INDEX entities_type_popularity_idx ON entities (type, popularity DESC);
CREATE INDEX relations_rel_idx ON relations (rel);
