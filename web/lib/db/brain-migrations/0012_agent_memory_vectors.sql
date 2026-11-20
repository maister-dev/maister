CREATE TABLE agent_memory_embeddings (
  vault_id text NOT NULL,
  note_id text NOT NULL,
  revision_id text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL,
  generation text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  vector vector,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  PRIMARY KEY (vault_id,note_id,revision_id,model,dimensions,generation),
  FOREIGN KEY (vault_id,note_id,revision_id) REFERENCES agent_memory_revisions(vault_id,note_id,id) ON DELETE RESTRICT,
  CHECK (state IN ('pending','ready','poisoned') AND attempts BETWEEN 0 AND 5),
  CHECK (dimensions BETWEEN 1 AND 65535 AND (vector IS NULL OR vector_dims(vector)=dimensions)),
  CHECK (generation ~ '^[0-9a-f]{64}$' AND (state='ready')=(vector IS NOT NULL)),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL) AND (lease_token IS NULL OR state='pending'))
);
--> statement-breakpoint
CREATE INDEX agent_memory_embeddings_due_idx
ON agent_memory_embeddings (model,dimensions,generation,next_attempt_at,vault_id,note_id)
WHERE state='pending';
