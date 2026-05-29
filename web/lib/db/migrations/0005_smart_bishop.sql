ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Bootstrap the single default admin. RBAC roles (incl. global admin) are NOT
-- granted by public registration — `register()` always creates `member`. The
-- one admin is seeded here so every deployment has exactly one bootstrap admin.
-- Default credentials: admin@maister.local / "maister-admin" (bcrypt, cost 12).
-- `must_change_password = true` forces a password change on first login, so the
-- well-known default password cannot be used past the operator's first sign-in.
-- Idempotent: re-running (or a later seed) is a no-op once the email exists.
INSERT INTO "users" ("id", "name", "email", "password_hash", "role", "must_change_password")
VALUES (
  'usr_bootstrap_admin',
  'Admin',
  'admin@maister.local',
  '$2b$12$.d5F51sqe5tklprDocroCe3IPNSe48UxRO7yGyjkdmSCjZYYTTfxy',
  'admin',
  true
)
ON CONFLICT ("email") DO NOTHING;
