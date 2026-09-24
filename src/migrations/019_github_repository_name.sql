ALTER TABLE publish_pages
  ADD COLUMN IF NOT EXISTS github_repo_name TEXT NOT NULL DEFAULT '';

UPDATE publish_pages
SET github_repo_name = split_part(github_repo, '/', 2)
WHERE github_repo_name = ''
  AND github_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$';
