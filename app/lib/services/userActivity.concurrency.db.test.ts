// فاز ۳ — گام ۱۱: تست concurrency واقعی با PostgreSQL واقعی
// Source: سناریوی اجباری Step 11 — «touchAuthenticatedActivity» باید زیر بار همزمان
// atomic/conditional باقی بماند: فقط یک invocation از N فراخوانی همزمان lastSeenAt را
// bump می‌کند و بقیه به‌دلیل شرط اتمیک throttle no-op هستند.
//
// قواعد Step 11:
// - PostgreSQL واقعی (نه mock، نه fake) — فقط skip واقعی وقتی DB واقعاً در دسترس نیست.
// - user اختصاصی فقط برای این تست؛ به هیچ رکورد موجود دست نمی‌زند.
// - cleanup همیشه در finally اجرا می‌شود؛ شکست cleanup در گزارش صریح اعلام می‌شود.
// - هیچ تغییر در service/schema/migration/business semantics.
//
// نکته‌ی execution: این فایل جزو vitest.config.ts (الگوی app/**/*.test.ts) است و
// توسط `npm test` هم اجرا می‌شود؛ پس `npm test` در این پروژه به PostgreSQL واقعی
// وابسته است (sandbox/محیط‌های دارای DB). اگر DB در دسترس نباشد، این تست با پیام
// REAL_POSTGRESQL_UNAVAILABLE fail می‌شود — هرگز سبزِ جعلی یا skip خاموش نیست.
// اجرای صریح تکی: `npx vitest run app/lib/services/userActivity.concurrency.db.test.ts`

import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"

import { touchAuthenticatedActivity } from "./userActivity.service"

/** فاصله‌ی ایمن از رکوردهای واقعی — پیشوند اختصاصی Step 11. */
const MARKER_EMAIL = "step11-concurrency-test@concurrency.internal"
const MARKER_USERNAME = "step11-concurrency-test"

/**
 * gate سخت‌گیرانه: فقط وقتی PrismaClient واقعی می‌تواند به PostgreSQL واقعی وصل شود
 * تست اجرا می‌شود. هر شکست اتصال → skip صریح با دلیل (گزارش Step 11 این را شفاف می‌کند).
 * نکته: با Vitest API استاندارد، skip کردن context-aware در runtime شرطی ساده نیست؛
 * به‌جای آن وقتی DB نبود تست با پیام واضح fail می‌شود تا هرگز «سبزِ جعلی» نباشد.
 */
let prisma: PrismaClient
let dbAvailable = false

beforeEach(async () => {
    if (!prisma) {
        prisma = new PrismaClient()
    }
    try {
        await prisma.$queryRaw`SELECT 1`
        dbAvailable = true
    } catch {
        dbAvailable = false
    }
})

afterAll(async () => {
    if (prisma) await prisma.$disconnect().catch(() => {})
})

describe("touchAuthenticatedActivity — real PostgreSQL concurrency (Step 11)", () => {
    it("bumps lastSeenAt exactly once under concurrent invocations on a dedicated user", async () => {
        if (!dbAvailable) {
            throw new Error(
                "REAL_POSTGRESQL_UNAVAILABLE: تست concurrency به PostgreSQL واقعی نیاز دارد؛ skip جعلی ممنوع است (Step 11).",
            )
        }

        // ---------- setup: user اختصاصی با lastSeenAt خیلی قدیمی ----------
        const staleSeen = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) // ۳۰ روز پیش
        const user = await prisma.user.create({
            data: {
                email: MARKER_EMAIL,
                username: MARKER_USERNAME,
                password: "not-a-real-login", // هش واقعی لازم نیست؛ ورود از این مسیر نیست
                lastSeenAt: staleSeen,
            },
            select: { id: true },
        })
        const userId = user.id
        let cleanupSucceeded = false
        let testFailedBeforeConcurrency = false

        try {
            // pre-condition: lastSeenAt قدیمی باشد تا window باز باشد
            const pre = await prisma.user.findUniqueOrThrow({
                where: { id: userId },
                select: { lastSeenAt: true },
            })
            expect(pre.lastSeenAt?.getTime()).toBe(staleSeen.getTime())

            // ---------- سناریو: N invocation همزمان، همان user، تقریباً همان now ----------
            const CONCURRENCY = 20
            const now = new Date()
            const results = await Promise.all(
                Array.from({ length: CONCURRENCY }, () =>
                    touchAuthenticatedActivity(userId, now, prisma),
                ),
            )

            // ---------- نتیجه‌ی atomic/throttle ----------
            const touched = results.filter((r) => r.touched).length
            expect(touched).toBe(1) // فقط یک invocation واقعاً bump کرد

            // مقدار نهایی lastSeenAt باید همان window (now) باشد — نه قدیمی، نه آینده
            const post = await prisma.user.findUniqueOrThrow({
                where: { id: userId },
                select: { lastSeenAt: true },
            })
            expect(post.lastSeenAt).not.toBeNull()
            expect(post.lastSeenAt!.getTime()).toBe(now.getTime())

            // اثبات conditional بودن: invocation بلافاصله‌ی بعدی (بدون عبور از throttle) no-op است
            const throttled = await touchAuthenticatedActivity(userId, now, prisma)
            expect(throttled.touched).toBe(false)
            const postThrottled = await prisma.user.findUniqueOrThrow({
                where: { id: userId },
                select: { lastSeenAt: true },
            })
            expect(postThrottled.lastSeenAt!.getTime()).toBe(now.getTime())

            cleanupSucceeded = true
        } catch (error) {
            testFailedBeforeConcurrency = true
            throw error
        } finally {
            // ---------- cleanup: همیشه؛ حتی وقتی assertionها شکست خوردند ----------
            try {
                await prisma.user.deleteMany({
                    where: { id: userId, email: MARKER_EMAIL, username: MARKER_USERNAME },
                })
            } catch (cleanupError) {
                cleanupSucceeded = false
                // شکست cleanup صریحاً اعلام می‌شود (Step 11) — بدون خوردن خطای اصلی
                console.error("STEP11_CLEANUP_FAILED", {
                    userId,
                    error: cleanupError instanceof Error ? cleanupError.message : cleanupError,
                })
            }
        }

        // قرارداد گزارش Step 11: cleanup موفق باید باشد؛ در غیر این صورت تست fail می‌شود
        if (!cleanupSucceeded && !testFailedBeforeConcurrency) {
            throw new Error("STEP11_CLEANUP_FAILED: حذف user اختصاصی ناموفق بود.")
        }
    })
})
