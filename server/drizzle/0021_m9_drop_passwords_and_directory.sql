-- M9 (docs/identity.md): Health passwords and the email directory go. LotusPond Accounts is the only way in.
-- Irreversible: take a backup first, and run accounts:cleanup-check on every host before this deploys.
DROP TABLE "directory" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";
