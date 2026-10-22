-- Who registered an agent, so a policy can keep that person from approving the agent's own purchases.
-- Null for agents created before this column existed.
ALTER TABLE agents ADD COLUMN created_by UUID REFERENCES users (id);
