ALTER TABLE "app_user" ADD COLUMN "is_protected" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_app_user_row() RETURNS trigger AS $$
BEGIN
  -- The deliberate escape hatch, used by protect-account and recover-admin. This does not
  -- defend against a DATABASE_URL holder -- they can set the GUC themselves, and can already
  -- rewrite every row. It defends against a future router or job that writes app_user
  -- directly and never learned about the domain-layer guard.
  IF coalesce(current_setting('app.protected_write', true), 'off') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Turning protection ON is restricted too: otherwise an ADMIN session could protect a
  -- colleague's account and lock them out of their own role. This also covers INSERT --
  -- a row born with is_protected = true and no GUC would be permanently undeletable and
  -- un-demotable, since every later UPDATE/DELETE branch below treats it as protected.
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_protected THEN
      RAISE EXCEPTION 'app_user row %: is_protected can only be set by the protect-account script', NEW.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT OLD.is_protected AND NEW.is_protected THEN
    RAISE EXCEPTION 'app_user row %: is_protected can only be set by the protect-account script', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT OLD.is_protected THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app_user row % is protected: DELETE is not permitted', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- password_hash, must_change_password, display_name and totp_secret stay writable, which
  -- is what keeps auth.changeOwnPassword and the forgot-password flow working with no GUC.
  IF NEW.email IS DISTINCT FROM OLD.email
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.is_protected IS DISTINCT FROM OLD.is_protected THEN
    RAISE EXCEPTION 'app_user row % is protected: email, role, is_active and is_protected cannot be changed', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS protect_app_user ON "app_user";
--> statement-breakpoint
CREATE TRIGGER protect_app_user
BEFORE INSERT OR UPDATE OR DELETE ON "app_user"
FOR EACH ROW EXECUTE FUNCTION protect_app_user_row();