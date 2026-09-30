// AI Quota v2 — مسیر مرکزی چرخهٔ حیات عملیات AI (Phase 2)
//
// هدف این ماژول یک چیز است: **یک AI caller جدید نباید بتواند quota را bypass کند.**
// هر route یا job جدیدی که AI صدا می‌زند باید فقط یک تابع را صدا بزند —
// `runAiOperation` — و همه‌ی مراحل زیر در آن متمرکز می‌مانند:
//
//   resolve policy → reserve → execute → complete / release
//
// چرا این‌قدر متمرکز؟
// - قاعدهٔ PROMO→BASE و منطق bucket فقط یک‌جا هست و نمی‌تواند در route‌ها واگرا شود.
// - `units` از جدول هزینهٔ فیچر می‌آید، پس route نمی‌تواند عدد دلخواه بفرستد.
// - مرز legacy/جدید همین‌جا تصمیم گرفته می‌شود، پس هیچ route‌ای لازم نیست خودش
//   بداند کدام ledger فعال است.
//
// تصمیم legacy/جدید (`resolveQuotaMode`):
//   LEGACY ⟺ periodStart < firstNewPeriodStart(cutoverAt, timezone)
// یعنی تا پایان دورهٔ فعلی، `AiUsage` معتبر می‌ماند و از دورهٔ بعد `AiQuotaBucket`.
// هیچ usage تاریخی بین ANALYZE/PLAN تفکیک یا نسبت داده نمی‌شود (بدون backfill).
//
// سهمیهٔ هدیه در **هر دو** mode یکسان رفتار می‌کند: BASE اول مصرف می‌شود و اگر
// جا نداشت، کسری از `AiQuotaBucket(source="PROMO")` همان بُعد می‌آید. در legacy
// این کار داخل `reserveQuota` انجام می‌شود و `complete`/`release` همان رزرو را از
// روی `AiUsageEvent.bucketId` به bucket برمی‌گردانند — پس این فایل فقط `dimension`
// را پاس می‌دهد و lifecycle تغییری نمی‌کند.
//
// وضعیت wiring: هر دو caller محصول — `PATCH /api/tasks/[id]/analyze` و
// `POST /api/planner/plan` — از این مسیر عبور می‌کنند. تنها آنچه در route باقی مانده
// auth/validation/rate-limit/analytics است؛ هیچ reserve/complete/release دستی باقی
// نمانده. انتخاب legacy/جدید اینجا و در لایهٔ سرویس انجام می‌شود، نه در route.
//
// `GET /api/ai/test` اصلاً در این فهرست نیست و **هرگز** نخواهد بود: آن endpoint
// تشخیصی است، در production ۴۰۴ می‌دهد و سهمیهٔ محصول مصرف نمی‌کند.

import { AiProviderUnavailableError, QuotaUnavailableError } from "./errors"
import { getMonthlyPeriod, resolvePlanPolicy } from "./planPolicy.service"
import { readCutoverAt, resolveQuotaMode, type QuotaMode } from "./aiQuotaCutover.service"
import { assertQuotaUnitsAllowed, resolveQuotaFeature, type AiFeatureName } from "./quotaPolicy.service"
import {
    completeQuota,
    releaseQuota,
    reserveQuota,
} from "./aiQuota.service"
import {
    completeBucketQuota,
    releaseBucketQuota,
    reserveBucketQuota,
    type QuotaSource,
} from "./aiQuotaV2.service"
import { markReleaseFailed, recordProviderOutcome, type ProviderOutcome, type PrismaClientLike } from "./aiUsage.service"
import { readAiCallTelemetry, type AiCallTelemetry } from "@/app/lib/ai/aiDuration"

export interface AiOperationCaller {
    id: number
    plan?: string | null
    timezone?: string | null
}

export interface RunAiOperationInput<T> {
    prisma: PrismaClientLike
    user: AiOperationCaller
    /** نام فیچر از جدول بستهٔ `AI_FEATURE_SPECS` — فیچر ثبت‌نشده throw می‌شود. */
    feature: AiFeatureName
    /** requestId سمت سرور ( observability context) — مبنای idempotency. */
    requestId: string
    now?: Date
    /**
     * اجرای خودِ عملیات AI. **هیچ‌وقت داخل transaction اجرا نمی‌شود** (سند §10).
     * اگر provider واقعی را می‌داند، آن را برگرداند تا در audit ثبت شود.
     */
    execute: () => Promise<{
        result: T
        telemetry?: AiCallTelemetry
        provider?: ProviderOutcome
    }>
    /**
     * نگاشت خطای `execute` به `AiUsageEvent.failureCode` هنگام release — اختیاری.
     *
     * چرا لازم است: هر caller قرارداد failureCode خودش را دارد و این‌ها عمداً فرق
     * می‌کنند (و نباید یکسان‌سازی شوند):
     * - `analyze`: فقط شکست provider کد می‌گیرد؛ بقیهٔ خطاها (مثل TASK_NOT_FOUND)
     *   بدون failureCode آزاد می‌شوند — عیناً رفتار فعلی.
     * - `plan`: علاوه بر provider، شکست اعتبارسنجیِ خروجی AI هم
     *   `AI_PLAN_INVALID` ثبت می‌شود، چون AI پاسخ داده ولی خروجی‌اش قابل استفاده
     *   نبوده است.
     *
     * پیش‌فرض همان قاعدهٔ `analyze` است، پس callerی که این را ندهد دقیقاً رفتار
     * پیشین را می‌گیرد. قاعدهٔ reserve/complete/release در این فایل می‌ماند؛ آنچه
     * اضافه می‌شود فقط **برچسب‌گذاری audit** است، نه منطق lifecycle.
     */
    releaseFailureCode?: (error: unknown) => string | undefined
}

export interface RunAiOperationResult<T> {
    result: T
    /** کدام ledger مصرف را تأمین کرد — برای لاگ/audit. */
    quotaMode: QuotaMode
    quotaSource: QuotaSource | "LEGACY"
    periodStart: Date
}

/**
 * تنها نقطهٔ ورود مجاز برای یک عملیات AI که سهمیه مصرف می‌کند.
 *
 * قرارداد خطا (همانند legacy، تغییری نکرده):
 * - شکست reserve → `QuotaExceededError` (429) یا `QuotaUnavailableError` (503).
 * - شکست `execute` → رزرو **آزاد** می‌شود و خطای اصلی rethrow می‌شود.
 * - شکست release → `markReleaseFailed` + `QuotaUnavailableError` (fail-closed).
 * - شکست complete → `QuotaUnavailableError` (fail-closed).
 */
export async function runAiOperation<T>(
    input: RunAiOperationInput<T>,
): Promise<RunAiOperationResult<T>> {
    const { prisma, user, requestId } = input
    const now = input.now ?? new Date()
    const timezone = user.timezone ?? "UTC"

    // 1) resolve policy — هزینه و بُعد فقط از جدول بستهٔ سمت سرور
    const spec = resolveQuotaFeature(input.feature)
    // M2: هزینهٔ > ۱ واحد فقط اگر spec آن را صریحاً `multiUnit: true` اعلام کرده باشد.
    // چون هزینه از خودِ spec می‌آید، این گارد در عمل همیشه می‌گذرد؛ وجودش یعنی اگر
    // روزی `spec.units` عوض شود، خودِ همین فایل locuss شکل را شکسته و fail-fast
    // می‌کند، نه اینکه یک رزروی چندواحدی بی‌صدا ثبت شود.
    assertQuotaUnitsAllowed(input.feature, spec.units)

    // 2) تصمیم legacy/جدید برای همین کاربر و همین لحظه
    const cutoverAt = await readCutoverAt(prisma)
    const periodStart = getMonthlyPeriod(now, timezone).periodStart
    const mode = resolveQuotaMode(periodStart, cutoverAt, timezone)

    // 3) reserve
    //    هزینه از `spec.units` می‌آید (جدول بستهٔ سمت سرور) — نه از بدنه، نه از
    //    جدول legacy. دو جدول برای فیچرهای موجود عملاً یکی هستند؛ اینجا جدول
    //    جدید مرجع است تا مسیر مرکزی یک منبع واحد داشته باشد.
    let quotaSource: QuotaSource | "LEGACY"
    if (mode === "LEGACY") {
        const legacyPolicy = resolvePlanPolicy({ plan: user.plan })
        const reservation = await reserveQuota(prisma, {
            userId: user.id,
            requestId,
            allowedUnits: legacyPolicy.allowedUnits,
            units: spec.units,
            feature: input.feature,
            periodStart,
            // بُعد از جدولِ بستهٔ فیچر می‌آید (نه hard-code، نه حدس از رشتهٔ feature):
            // در legacy یعنی «اگر BASE پر شد، کسری از سهمیهٔ هدیهٔ همین بُعد مصرف شود».
            dimension: spec.dimension,
        })
        // `"LEGACY"` یعنی مصرف از استخرِ مشترکِ `AiUsage` آمده (رفتار قبلی). اگر از
        // PROMO آمده باشد، منبع واقعی گزارش می‌شود تا audit/لاگ صادق بماند.
        quotaSource = reservation.quotaSource === "PROMO" ? "PROMO" : "LEGACY"
    } else {
        const reservation = await reserveBucketQuota(prisma, {
            userId: user.id,
            requestId,
            feature: spec.dimension,
            units: spec.units,
            multiUnit: spec.multiUnit,
            plan: user.plan,
            timezone,
            now,
        })
        // منبع واقعی مصرف (PROMO یا BASE) از خود رزرو می‌آید، نه از حدس.
        quotaSource = reservation.quotaSource
    }

    // 4) اجرا + complete/release
    let outcome: Awaited<ReturnType<RunAiOperationInput<T>["execute"]>>
    try {
        outcome = await input.execute()
    } catch (error) {
        await releaseReservation({
            prisma,
            mode,
            requestId,
            periodStart,
            failureCode: resolveFailureCode(input.releaseFailureCode, error),
            telemetry: readAiCallTelemetry(error),
        })
        throw error
    }

    // provider واقعی (نه hard-code) روی همان رویداد ثبت می‌شود — تصمیم D6
    if (outcome.provider) {
        await recordProviderOutcome(prisma, requestId, outcome.provider)
    }

    if (mode === "LEGACY") {
        await completeQuota(prisma, requestId, undefined, { periodStart }, outcome.telemetry)
    } else {
        await completeBucketQuota(prisma, requestId, { periodStart }, outcome.telemetry)
    }

    return {
        result: outcome.result,
        quotaMode: mode,
        quotaSource,
        periodStart,
    }
}

/**
 * قاعدهٔ پیش‌فرض failureCode — دقیقاً رفتار پیشین `analyze`.
 *
 * فقط شکست provider برچسب می‌گیرد؛ سایر خطاها (TASK_NOT_FOUND، TASK_NOT_ANALYZEABLE و
 *…) بدون failureCode آزاد می‌شوند، چون «چرا AI اجرا نشد» نیستند و صرفاً نشانهٔ
 * این‌اند که رزرو باید آزاد شود.
 */
function resolveFailureCode(
    resolver: ((error: unknown) => string | undefined) | undefined,
    error: unknown,
): string | undefined {
    if (resolver) return resolver(error)
    return error instanceof AiProviderUnavailableError ? error.code : undefined
}

async function releaseReservation(args: {
    prisma: PrismaClientLike
    mode: QuotaMode
    requestId: string
    periodStart: Date
    failureCode?: string
    telemetry?: AiCallTelemetry
}): Promise<void> {
    const { prisma, mode, requestId, periodStart, failureCode, telemetry } = args
    try {
        if (mode === "LEGACY") {
            await releaseQuota(prisma, requestId, undefined, { periodStart, failureCode }, telemetry)
        } else {
            await releaseBucketQuota(prisma, requestId, { periodStart, failureCode }, telemetry)
        }
    } catch {
        // release failure → reservation باقی می‌ماند و reconcilable است (سند §13)
        await markReleaseFailed(prisma, requestId)
        throw new QuotaUnavailableError()
    }
}
