// فاز ۱ — ثبت فعالیت کاربر احرازهویت‌شده (سند §17)
// lastSeenAt با throttle 30 دقیقه: فقط meaningful API activity و فقط در صورت
// عبور از آستانه، DB را می‌نویسد. در غیر این صورت no-op.
//Fail-safe: خطای ثبت فعالیت هرگز نباید مسیر اصلی API را بشکند.

const THROTTLE_MS = 30 * 60 * 1000 // 30 دقیقه

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
