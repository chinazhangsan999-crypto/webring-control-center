ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_nodes_delivery_order
  ON nodes(enabled, sort_order DESC, id ASC);
