// فاز ۱ — ثبت فعالیت کاربر احرازهویت‌شده (سند §17)
// lastSeenAt با throttle 30 دقیقه: فقط meaningful API activity و فقط در صورت
// عبور از آستانه، DB را می‌نویسد. در غیر این صورت no-op.
//Fail-safe: خطای ثبت فعالیت هرگز نباید مسیر اصلی API را بشکند.

// فاز ۳ — گام ۶: Active User Stats (سند فاز ۳ §15) — الحاق additive
// منبع هر سه metric فقط User.lastSeenAt است؛ ProductEvent برای این metricها
// query نمی‌شود. Rolling UTC windows؛ بدون Jalali/canonicalDay/session/anonymous؛
// بدون فیلد boolean جدید "active". فقط read — بدون mutation.

const THROTTLE_MS = 30 * 60 * 1000 // 30 دقیقه

// ---------------------------------------------------------------------------
// فاز ۳ — گام ۶: getActiveUserStats (DAU / WAU / MAU)
// ---------------------------------------------------------------------------

/** پنجره‌های rolling به ساعت — قفل‌شده طبق سند فاز ۳ §15. */
export const ACTIVE_USER_WINDOWS_HOURS = {
    dau: 24,
    wau: 168,
    mau: 720,
} as const

/** نتیجه‌ی آمار کاربران فعال — شمارش کاربران (distinct از جنس User)، نه رویدادها. */
export interface ActiveUserStatsResult {
    /** کاربرانی با lastSeenAt >= now - 24h (rolling UTC) */
    dau: number
    /** کاربرانی با lastSeenAt >= now - 168h (شامل زیرمجموعه‌ی DAU) */
    wau: number
    /** کاربرانی با lastSeenAt >= now - 720h (شامل زیرمجموعه‌های WAU/DAU) */
    mau: number
}

/** شکل مینیمال کلاینت موردنیاز — تزریق‌پذیر برای تست (الگوی موجود سرویس). */
export interface ActiveUserStatsClient {
    user: {
        count: (args: { where: { lastSeenAt: { gte: Date } } }) => Promise<number>
    }
}

function countActiveSince(
    client: ActiveUserStatsClient,
    since: Date,
): Promise<number> {
    // gte روی ستون nullable خودکار nullها را حذف می‌کند (lastSeenAt IS NOT NULL ضمنی)
    return client.user.count({ where: { lastSeenAt: { gte: since } } })
}

/**
 * getActiveUserStats — آمار کاربران فعال بر اساس rolling UTC windows.
 *
 * - منبع: فقط User.lastSeenAt (سند §15) — بدون ProductEvent aggregation.
 * - count از جنس User است → هر کاربر حداکثر یک‌بار در هر پنجره شمرده می‌شود.
 * - now تزریق‌پذیر است تا boundaryها deterministic و قابل تست باشند.
 * - Fail-open (سند §17): هر شکست read → صفرها؛ هرگز throw نمی‌کند و ErrorLog
 *   را وارد حلقه نمی‌کند (الگوی همین سرویس: swallow بدون گزارش از این لایه).
 * - فقط read؛ بدون mutation؛ بدون migration/schema change؛ بدون index جدید.
 */
export async function getActiveUserStats(
    now: Date,
    prismaClient: ActiveUserStatsClient,
): Promise<ActiveUserStatsResult> {
    const empty: ActiveUserStatsResult = { dau: 0, wau: 0, mau: 0 }
    try {
        if (!(now instanceof Date) || Number.isNaN(now.getTime())) return empty
        if (!prismaClient?.user || typeof prismaClient.user.count !== "function") return empty

        const hourMs = 60 * 60 * 1000
        const [dau, wau, mau] = await Promise.all([
            countActiveSince(prismaClient, new Date(now.getTime() - ACTIVE_USER_WINDOWS_HOURS.dau * hourMs)),
            countActiveSince(prismaClient, new Date(now.getTime() - ACTIVE_USER_WINDOWS_HOURS.wau * hourMs)),
            countActiveSince(prismaClient, new Date(now.getTime() - ACTIVE_USER_WINDOWS_HOURS.mau * hourMs)),
        ])
        return { dau, wau, mau }
    } catch {
        // Fail-open: شکست خواندن analytics هرگز مسیر اصلی را نمی‌شکند (سند §17)
        return empty
    }
}

export interface TouchActivityResult {
    /** آیا update انجام شد؟ */
    touched: boolean
}

/**
 * touchAuthenticatedActivity — lastSeenAt کاربر را با throttle ۳۰ دقیقه‌ای به‌روز می‌کند.
 * شرط update: lastSeenAt === null یا (now - lastSeenAt) >= 30 دقیقه.
 * @param userId     فقط از authenticated server-side identity (هرگز از کلاینت)
 * @param now        لحظه‌ی فعلی (تزریق‌پذیر برای تست)
 * @param prismaClient کلاینت Prisma (تزریق‌پذیر برای تست)
 */
export async function touchAuthenticatedActivity(
    userId: number,
    now: Date,
    prismaClient: any,
): Promise<TouchActivityResult> {
    try {
        // conditional update: هم شرط throttle و هم null بودن در یک query — اتمیک، بدون read-then-write.
        const result = await prismaClient.user.updateMany({
            where: {
                id: userId,
                OR: [
                    { lastSeenAt: null },
                    { lastSeenAt: { lte: new Date(now.getTime() - THROTTLE_MS) } },
                ],
            },
            data: { lastSeenAt: now },
        })
        return { touched: result.count === 1 }
    } catch {
        // Fail-safe: خطای telemetry هرگز پاسخ کاربر را نباید مختل کند (recordError در لایه‌ی فراخوان).
        return { touched: false }
    }
}
