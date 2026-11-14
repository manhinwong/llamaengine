-- Open version: investors are created by the people using the page. Both tables are append-only from the browser.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL CHECK (profile_id ~ '^[a-z0-9]{2,20}$'),
  space text NOT NULL CHECK (space ~ '^[a-z0-9]{2,20}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  prefs jsonb NOT NULL CHECK (pg_column_size(prefs) < 4000),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_space_idx ON public.profiles (space, at);
CREATE TABLE public.feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor text NOT NULL CHECK (investor ~ '^[A-Za-z0-9]{1,20}$'),
  candidate_id text NOT NULL CHECK (char_length(candidate_id) <= 40),
  vote smallint NOT NULL CHECK (vote IN (1, -1)),
  reason text NOT NULL CHECK (reason IN ('love_space', 'love_founder', 'wrong_sector', 'too_late', 'weak_founder_fit', 'not_ai_native')),
  session text CHECK (session ~ '^[a-z0-9]{2,20}$'),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_events_session_idx ON public.feedback_events (session, at);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY profiles_insert ON public.profiles FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY feedback_read ON public.feedback_events FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY feedback_insert ON public.feedback_events FOR INSERT TO anon, authenticated WITH CHECK (true);
REVOKE ALL ON public.profiles, public.feedback_events FROM anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT ON public.profiles, public.feedback_events TO anon, authenticated;
