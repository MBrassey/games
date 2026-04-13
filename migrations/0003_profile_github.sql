-- Extended profile fields harvested from the GitHub OAuth profile on sign-in.
-- Everything is optional except the existing handle column (which gets
-- populated from github login on first sign-in).

ALTER TABLE user_profiles ALTER COLUMN handle DROP NOT NULL;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS avatar_url     TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS github_login   TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS github_id      BIGINT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS location       TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS blog           TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS company        TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS twitter        TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS public_repos   INTEGER;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS followers      INTEGER;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS github_html_url TEXT;
