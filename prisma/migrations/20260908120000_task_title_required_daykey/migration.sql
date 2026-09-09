-- Phase C1 — Task CRUD Foundation
-- Align Task model with architecture §6.2:
--   - text → title (field name used by §2.4 / §3.10.A and the C1 data-layer spec)
--   - dayKey → required (server-computed grouping key per §6.2.2.1; never null for a valid task)
-- Database is empty (confirmed by G-02 dry-run reports), so no data backfill is needed.

ALTER TABLE "Task" RENAME COLUMN "text" TO "title";

ALTER TABLE "Task" ALTER COLUMN "dayKey" SET NOT NULL;