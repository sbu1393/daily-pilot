DO $$
BEGIN
  IF EXISTS (
    SELECT "username" FROM "User" GROUP BY "username" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add unique username constraint: duplicate usernames exist';
  END IF;
END $$;

ALTER TABLE "User" ADD CONSTRAINT "User_username_key" UNIQUE ("username");
