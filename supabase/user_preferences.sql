-- PSD Procurement Tracker — per-user form defaults.
--
-- Run this script ONCE in the Supabase SQL editor (after auth_policies.sql)
-- to create a private preferences table for each signed-in user.

CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  preferences jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE  schemaname = 'public' AND tablename = 'user_preferences'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_preferences',
                   pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "user_select_own_prefs"
  ON public.user_preferences
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "user_insert_own_prefs"
  ON public.user_preferences
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_update_own_prefs"
  ON public.user_preferences
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_delete_own_prefs"
  ON public.user_preferences
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.user_preferences FROM anon;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.user_preferences TO authenticated;
