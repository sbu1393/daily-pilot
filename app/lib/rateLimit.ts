// محدودساز نرخ ساده و درون‌حافظه‌ای (به ازای هر اینستنس سرور)
// برای محیط‌های چند-اینستنس یا سرورلس باید به Redis/DB منتقل شود؛
// اما برای MVP همین لایه از Brute-force ساده جلوگیری می‌کند.

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

// M2 — پاک‌سازی دوره‌ای bucketهای منقضی تا این Map در طول عمر پروسه بی‌نهایت رشد نکند.
// هزینه: یک پیمایش فقط هر CLEANUP_INTERVAL_MS (نه روی هر درخواست) — رفتار هیچ کاربر
// فعالی تغییر نمی‌کند، فقط کلیدهای مرده حذف می‌شوند.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
let lastCleanupAt = 0

/**
 * bucketهای منقضی را حذف می‌کند و تعداد حذف‌شده‌ها را برمی‌گرداند.
 * هم به‌صورت خودکار (با فاصله‌ی زمانی) از isRateLimited صدا زده می‌شود و هم قابل
 * فراخوانی مستقیم است.
 */
export function pruneExpiredBuckets(now: number = Date.now()): number {
    let removed = 0
    for (const [key, bucket] of buckets) {
        if (now > bucket.resetAt) {
            buckets.delete(key)
            removed += 1
        }
    }
    return removed
}

export function isRateLimited(
    key: string,
    maxAttempts = 10,
    windowMs = 15 * 60 * 1000,
): boolean {
    const now = Date.now()

    // پیمایش دوره‌ای (amortized) — نه روی هر درخواست
    if (now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
        lastCleanupAt = now
        pruneExpiredBuckets(now)
    }

    const bucket = buckets.get(key)

    if (!bucket || now > bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs })
        return false
    }

    bucket.count += 1
    return bucket.count > maxAttempts
}

/** IP کاربر (با توجه به پراکسی‌های معمول) — در حد کافی برای rate limiting */
export function clientIp(req: Request): string {
    const forwarded = req.headers.get("x-forwarded-for")
    if (forwarded) return forwarded.split(",")[0].trim()
    return req.headers.get("x-real-ip") || "unknown"
}