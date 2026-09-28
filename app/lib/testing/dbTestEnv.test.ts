import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* نگهبان fail-closed تست‌های DB — تست واحد (بدون اتصال به دیتابیس)    */
/*                                                                     */
/* این فایل عمداً هیچ PrismaClient‌ای نمی‌سازد و به هیچ DB وصل نمی‌شود؛  */
/* فقط منطق تصمیم‌گیری را می‌سنجد. این نکته مهم است: همین تست باید    */
/* در هر محیطی (حتی بدون دیتابیس) سبز باشد.                            */
/*                                                                     */
/* هدف: تضمین اینکه یک URL پروداکشن هرگز `ok` نمی‌گیرد — چون کل         */
/* امنیت این تغییر به همین یک قید بستگی دارد.                           */
/* ------------------------------------------------------------------ */

import { assertTestDatabase, checkDatabaseUrl, newTestRunId, testMarker } from "./dbTestEnv"

/** URL واقعیِ پروداکشن روزساز (Neon) — باید همیشه رد شود. */
const PROD_URL =
    "postgresql://user:pw@ep-gentle-sky-b1zvg5w5-pooler.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require"

describe("checkDatabaseUrl — رد مقصدهای ناشناخته و پروداکشن (fail-closed)", () => {
    it("rejects the real production Neon URL", () => {
        const result = checkDatabaseUrl(PROD_URL)
        expect(result.ok).toBe(false)
    })

    it("rejects a Neon URL even when the database name contains 'test'", () => {
        // نام دیتابیس تنها ملاک نیست؛ میزبان production باید رد شود.
        const result = checkDatabaseUrl(
            "postgresql://u:p@ep-foo-pooler.c-5.eu-central-1.aws.neon.tech/neondb_test?sslmode=require",
        )
        expect(result.ok).toBe(false)
    })

    it("rejects a plain remote Postgres host", () => {
        expect(
            checkDatabaseUrl("postgresql://u:p@db.example.com:5432/rouzsaz").ok,
        ).toBe(false)
    })

    it("rejects other managed hosts even with a test-named database", () => {
        // branch تست ممکن است نام تستی داشته باشد، ولی اگر endpoint اشتباه باشد
        // نباید مجوز بدهد.
        for (const url of [
            "postgresql://u:p@db.abc.supabase.co:5432/postgres_test",
            "postgresql://u:p@svc.up.railway.app:5432/rouzsaz_test",
            "postgresql://u:p@app.fly.dev:5432/rouzsaz-test",
        ]) {
            expect(checkDatabaseUrl(url).ok, url).toBe(false)
        }
    })

    it("rejects a missing URL", () => {
        expect(checkDatabaseUrl(undefined).ok).toBe(false)
        expect(checkDatabaseUrl(null).ok).toBe(false)
        expect(checkDatabaseUrl("").ok).toBe(false)
        expect(checkDatabaseUrl("   ").ok).toBe(false)
    })

    it("rejects a malformed URL", () => {
        expect(checkDatabaseUrl("not a url at all").ok).toBe(false)
    })

    it("rejects a non-postgres protocol", () => {
        expect(checkDatabaseUrl("mysql://u:p@localhost:3306/test").ok).toBe(false)
    })
})

describe("checkDatabaseUrl — پذیرش مقصدهای تست معتبر", () => {
    it("accepts localhost", () => {
        expect(checkDatabaseUrl("postgresql://u:p@localhost:5432/rouzsaz_test").ok).toBe(true)
    })

    it("accepts 127.0.0.1", () => {
        expect(checkDatabaseUrl("postgresql://u:p@127.0.0.1:5432/postgres").ok).toBe(true)
    })

    it("accepts an explicitly test-named database", () => {
        expect(checkDatabaseUrl("postgresql://u:p@db.internal:5432/rouzsaz_test").ok).toBe(true)
        expect(checkDatabaseUrl("postgresql://u:p@db.internal:5432/rouzsaz-test").ok).toBe(true)
        expect(checkDatabaseUrl("postgresql://u:p@db.internal:5432/rouzsaz_testdb").ok).toBe(true)
    })

    it("accepts the dedicated test port 5433", () => {
        expect(checkDatabaseUrl("postgresql://u:p@db.internal:5433/rouzsaz").ok).toBe(true)
    })

    it("accepts a managed host ONLY with an explicit test port", () => {
        // استثنای محدود: پورت تستِ صریح یعنی endpoint واقعاً جداست.
        expect(
            checkDatabaseUrl("postgresql://u:p@ep-foo.c-5.aws.neon.tech:5433/neondb").ok,
        ).toBe(true)
    })

    it("gives a human-readable reason on success", () => {
        const result = checkDatabaseUrl("postgresql://u:p@localhost:5432/x")
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.reason.length).toBeGreaterThan(0)
    })

    it("gives a human-readable reason on failure", () => {
        const result = checkDatabaseUrl(PROD_URL)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
    })
})

describe("assertTestDatabase — throw روی پروداکشن", () => {
    it("throws for the production URL (no write may happen before this)", () => {
        expect(() => assertTestDatabase(PROD_URL)).toThrow(/DB_TEST_NOT_ALLOWED/)
    })

    it("the error message states DB tests only run on a test database", () => {
        expect(() => assertTestDatabase(PROD_URL)).toThrow(/دیتابیس تست/)
    })

    it("does not throw for a valid test database", () => {
        expect(() => assertTestDatabase("postgresql://u:p@localhost:5432/x_test")).not.toThrow()
    })

    it("throws when no URL is provided at all", () => {
        expect(() => assertTestDatabase(undefined)).toThrow(/DB_TEST_NOT_ALLOWED/)
    })
})

describe("marker یکتا برای هر اجرا", () => {
    it("produces different run ids", () => {
        const ids = new Set(Array.from({ length: 200 }, () => newTestRunId()))
        expect(ids.size).toBe(200)
    })

    it("builds a marker containing the prefix", () => {
        const marker = testMarker("step11")
        expect(marker.startsWith("step11-")).toBe(true)
    })

    it("uses the non-resolvable .invalid domain so markers can never be real addresses", () => {
        expect(testMarker("step11")).toContain("@dbtest.invalid")
    })

    it("two markers never collide (parallel / rerun safety)", () => {
        const markers = new Set(Array.from({ length: 200 }, () => testMarker("phase1-quota")))
        expect(markers.size).toBe(200)
    })

    it("accepts an explicit run id for deterministic cleanup", () => {
        expect(testMarker("phase2", "fixed-run")).toBe("phase2-fixed-run@dbtest.invalid")
    })
})
