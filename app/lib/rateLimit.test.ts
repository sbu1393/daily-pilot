import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* M2 (audit) — محدودساز نرخ درون‌حافظه‌ای: پاک‌سازی bucketهای منقضی.     */
/* بدون پاک‌سازی، Map تا عمر پروسه بی‌نهایت رشد می‌کند.                  */
/* هر تست ماژول را تازه ایمپورت می‌کند تا state ماژول (buckets/lastCleanupAt) */
/* بین تست‌ها نشت نکند.                                                 */
/* ------------------------------------------------------------------ */

const T0 = new Date("2026-03-05T10:00:00.000Z")

const loadModule = async () => {
    vi.resetModules()
    return import("./rateLimit")
}

describe("rateLimit (M2 — pruning)", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(T0)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it("removes expired buckets, reports the count, and is idempotent", async () => {
        const { isRateLimited, pruneExpiredBuckets } = await loadModule()

        isRateLimited("login:ip:1.1.1.1", 10, 60_000) // پنجره‌ی ۶۰ ثانیه
        isRateLimited("login:ip:2.2.2.2", 10, 1_000) // پنجره‌ی ۱ ثانیه

        vi.setSystemTime(new Date(T0.getTime() + 5_000)) // دومی منقضی، اولی هنوز زنده

        expect(pruneExpiredBuckets()).toBe(1)
        expect(pruneExpiredBuckets()).toBe(0) // دیگر چیزی برای پاک کردن نیست
    })

    it("keeps live buckets intact — counting continues after a prune", async () => {
        const { isRateLimited, pruneExpiredBuckets } = await loadModule()

        expect(isRateLimited("k", 2, 60_000)).toBe(false) // count = 1
        vi.setSystemTime(new Date(T0.getTime() + 5_000))
        expect(pruneExpiredBuckets()).toBe(0) // bucket فعال پاک نمی‌شود

        expect(isRateLimited("k", 2, 60_000)).toBe(false) // count = 2
        expect(isRateLimited("k", 2, 60_000)).toBe(true) // count = 3 > 2 → محدود
    })

    it("sweeps expired buckets automatically at most once per interval", async () => {
        const { isRateLimited, pruneExpiredBuckets } = await loadModule()

        isRateLimited("dead", 10, 1_000) // مرده تا ۱ ثانیه

        vi.setSystemTime(new Date(T0.getTime() + 10 * 60 * 1000))
        // این فراخوانی، sweep دوره‌ای (۵ دقیقه) را اجرا می‌کند
        isRateLimited("live", 10, 60 * 60 * 1000)

        expect(pruneExpiredBuckets()).toBe(0) // «dead» قبلاً خودکار پاک شده است
    })

    it("restarts counting when the window has elapsed (behavior preserved)", async () => {
        const { isRateLimited } = await loadModule()

        expect(isRateLimited("k", 1, 1_000)).toBe(false) // count = 1
        expect(isRateLimited("k", 1, 1_000)).toBe(true) // count = 2 > 1

        vi.setSystemTime(new Date(T0.getTime() + 2_000))
        expect(isRateLimited("k", 1, 1_000)).toBe(false) // پنجره‌ی تازه
    })
})
