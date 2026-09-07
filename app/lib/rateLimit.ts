// محدودساز نرخ ساده و درون‌حافظه‌ای (به ازای هر اینستنس سرور)
// برای محیط‌های چند-اینستنس یا سرورلس باید به Redis/DB منتقل شود؛
// اما برای MVP همین لایه از Brute-force ساده جلوگیری می‌کند.

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

export function isRateLimited(
    key: string,
    maxAttempts = 10,
    windowMs = 15 * 60 * 1000,
): boolean {
    const now = Date.now()
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