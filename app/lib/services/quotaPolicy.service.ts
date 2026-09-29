// AI Quota v2 — منبع حقیقت سقف‌ها (Phase 2)
//
// قواعد LOCKED:
// - سقف **فقط** از جدول `AiQuotaPolicy` خوانده می‌شود. هیچ عددی (۱۵/۲/۲۷۰/۵۰) در
//   source code وجود ندارد و هیچ route نمی‌تواند آن را hard-code کند.
// - دو بُعد **کاملاً مستقل**: ANALYZE و PLAN سهمیه‌ی جدا دارند و مصرف یکی از دیگری
//   کم نمی‌کند.
// - `units` (هزینه‌ی هر عملیات) هم **فقط** از جدول زیر و **فقط** سمت سرور می‌آید؛
//   هرگز از بدنه‌ی درخواست پذیرفته نمی‌شود.
// - خطای DB → fail-closed (`QuotaUnavailableError`). ردیف policy گمشده هم
//   fail-closed است: هرگز به «سهمیه‌ی نامحدود» خاموش برنمی‌گردیم.
//
// مقادیر seed نهایی محصول (در `prisma/migrations/20260929120000_...`):
//   FREE: ANALYZE=15, PLAN=2   ·   PRO: ANALYZE=270, PLAN=50

import type { AiFeature, UserPlan } from "@prisma/client"

import { writeAdminAuditLog } from "./adminAudit.service"
import { QuotaUnavailableError, ServiceError } from "./errors"
import type { PrismaClientLike } from "./aiUsage.service"

/* ──────────────────────────────────────────────────────────────────────────── */
/* نگاشت فیچر → بُعد سهمیه + هزینه (تنها منبع، فقط سمت سرور)                     */
/* ──────────────────────────────────────────────────────────────────────────── */

export interface QuotaFeatureSpec {
    /** بُعد سهمیه‌ای که این فیچر مصرف می‌کند. */
    dimension: AiFeature
    /** هزینه‌ی هر «عملیات منطقی» بر حسب واحد سهمیه. */
    units: number
    /**
     * آیا این فیچر **عمداً** چندواحدی است (M2).
     *
     * قاعده: هزینه‌ی بیشتر از ۱ واحد فقط و فقط وقتی مجاز است که این پرچم صریحاً
     * `true` باشد. در غیر این صورت `resolveQuotaFeature` اجازه‌ی `units > 1` نمی‌دهد و
     * `reserveBucketQuota` هم fail-fast می‌کند. یعنی یک caller آینده که تصادفی
     * `units=2` یا `units=500` بدهد، **قبل** از هر نوشتنی در DB متوقف می‌شود.
     *
     * همهٔ فیچرهای محصولِ فعلی تک‌واحدی‌اند (ANALYZE=1، PLAN=1) و این پرچم برای
     * همه‌شان `false` است. `ai-test` دیگر اصلاً فیچر سهمیه‌ای نیست (تصمیم قطعی) و
     * در این جدول وجود ندارد.
     */
    multiUnit: boolean
    /** برچسب داخلی (نه فارسی، برای لاگ/audit). */
    name: string
}

/**
 * فهرست بسته‌ی AI featureها.
 *
 * عمداً یک **نگاشت صریح** است، نه `feature → feature`: هر caller جدیدِ AI باید
 * بُعد سهمیه و هزینه‌اش را اینجا اعلام کند. فیچرِ ثبت‌نشده `resolveQuotaFeature`
 * را می‌شکند (و نه سروصدا به حالت پیش‌فرض می‌رود) — این همان چیزی است که از
 * «دور زدن سهمیه با یک route جدید» جلوگیری می‌کند.
 *
 * - `analyze`  → بُعد ANALYZE (تحلیل تسک).
 * - `plan`     → بُعد PLAN (تولید برنامه‌ی روز؛ یک درخواست = یک واحد، مستقل از
 *                تعداد تسک‌ها).
 * - `ai-test`  → وجود ندارد. این endpoint تشخیصی/داخلی است، در production ۴۰۴ است،
 *                UI/caller ندارد و **عمداً هیچ quota واقعی مصرف نمی‌کند**؛ پس نه
 *                به بعدِ ANALYZE نگاشت می‌شود و نه feature جدیدی می‌گیرد. عده
 *                `AI_TEST_UNITS = 3` صرفاً تعداد sampleهای داخلی بود، نه هزینهٔ
 *                محصول. `resolveQuotaFeature("ai-test")` عمداً throw می‌کند.
 *
 * نتیجه: جدول سیاستِ محصول دقیقاً همان **چهار** ترکیب باقی می‌ماند —
 *   FREE: ANALYZE=15, PLAN=2   ·   PRO: ANALYZE=270, PLAN=50
 *
 * قاعدهٔ M2: هزینهٔ بیشتر از ۱ واحد فقط با `multiUnit: true` مجاز است (توضیح بالا).
 * هر دو فیچر فعلی تک‌واحدی‌اند.
 */
export const AI_FEATURE_SPECS = {
    analyze: { dimension: "ANALYZE", units: 1, multiUnit: false, name: "analyze" },
    plan: { dimension: "PLAN", units: 1, multiUnit: false, name: "plan" },
} as const satisfies Record<string, QuotaFeatureSpec>

export type AiFeatureName = keyof typeof AI_FEATURE_SPECS

/** 400 — فیچرِ AI ثبت‌نشده (یعنی سهمیه‌اش تعریف نشده). */
export class UnknownAiFeatureError extends ServiceError {
    constructor(feature: string) {
        super(
            400,
            "UNKNOWN_AI_FEATURE",
            `قابلیت هوش مصنوعی «${feature}» سهمیه‌ی تعریف‌شده ندارد`,
            undefined,
            "VALIDATION",
            "WARNING",
        )
    }
}

/** resolve فیچر → (بُعد، هزینه). فقط سمت سرور؛ ورودی از بدنه‌ی درخواست نمی‌آید. */
export function resolveQuotaFeature(feature: string): QuotaFeatureSpec {
    const spec = (AI_FEATURE_SPECS as Record<string, QuotaFeatureSpec | undefined>)[feature]
    if (!spec) throw new UnknownAiFeatureError(feature)
    return spec
}

/** 400 — `units > 1` برای فیچری که `multiUnit !== true` اعلام کرده (قاعدهٔ M2). */
export class MultiUnitNotAllowedError extends ServiceError {
    constructor(feature: string, units: number) {
        super(
            400,
            "AI_FEATURE_NOT_MULTI_UNIT",
            `قابلیت «${feature}» تک‌واحدی است و نمی‌تواند ${units} واحد سهمیه مصرف کند`,
            undefined,
            "VALIDATION",
            "WARNING",
        )
    }
}

/**
 * M2 — گارد هزینهٔ عملیات، fail-fast و **قبل** از هر نوشتنی در DB.
 *
 * قاعده: هزینهٔ بیشتر از ۱ واحد فقط با `multiUnit: true` مجاز است. بدون این گارد،
 * یک caller آینده می‌توانست `units=500` بدهد و یک رزرو ۵۰۰تایی ثبت کند — که با
 * invariant تک‌سطلیِ `reserveBucketQuota` (M1) هرگز قصد نشده بود و به‌سادگی رد
 * می‌شد، ولی خطای گمراه‌کننده می‌داد.
 *
 * چرا خطای ۴۰۰ و نه ۵۰۳: این یک **باگ برنامه‌نویسی** است، نه خرابی زیرساخت؛
 * fail-fast یعنی همان لحظه و با پیام روشن متوقف شود.
 */
export function assertQuotaUnitsAllowed(feature: string, units: number): void {
    if (!Number.isInteger(units) || units <= 0) {
        throw new MultiUnitNotAllowedError(feature, units)
    }
    const spec = resolveQuotaFeature(feature)
    if (units > 1 && spec.multiUnit !== true) {
        throw new MultiUnitNotAllowedError(feature, units)
    }
}

/** plan کاربر → plan معتبر (هر مقدار ناشناخته = FREE، نه PRO). */
export function normalizePlan(plan: string | null | undefined): UserPlan {
    return plan === "PRO" ? "PRO" : "FREE"
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* خواندن policy                                                             */
/* ──────────────────────────────────────────────────────────────────────────── */

export interface QuotaPolicySnapshot {
    plan: UserPlan
    feature: AiFeature
    allowedUnits: number
}

/** کل جدول policy (۴ ردیف) — برای نمایش ادمین و health check. */
export async function listQuotaPolicies(
    prisma: PrismaClientLike,
): Promise<QuotaPolicySnapshot[]> {
    try {
        const rows = await prisma.aiQuotaPolicy.findMany({
            select: { plan: true, feature: true, allowedUnits: true },
            orderBy: [{ plan: "asc" }, { feature: "asc" }],
        })
        return rows as QuotaPolicySnapshot[]
    } catch {
        throw new QuotaUnavailableError()
    }
}

/**
 * سقف زنده‌ی یک (plan × feature).
 *
 * fail-closed: ردیف نبودن یعنی پیکربندی ناقص، نه «بی‌نهایت». ادمین باید هر ۴ ردیف
 * را داشته باشد (seed این کار را می‌کند).
 */
export async function readQuotaPolicy(
    prisma: PrismaClientLike,
    plan: UserPlan,
    feature: AiFeature,
): Promise<number> {
    try {
        const row = await prisma.aiQuotaPolicy.findUnique({
            where: { plan_feature: { plan, feature } },
            select: { allowedUnits: true },
        })
        if (!row || typeof row.allowedUnits !== "number") throw new QuotaUnavailableError()
        return row.allowedUnits
    } catch (error) {
        if (error instanceof QuotaUnavailableError) throw error
        throw new QuotaUnavailableError()
    }
}

/** snapshot کامل: plan کاربر + feature → سقف. رایج‌ترین ورودی reserve. */
export async function resolveUserQuota(
    prisma: PrismaClientLike,
    user: { plan?: string | null },
    feature: AiFeature,
): Promise<QuotaPolicySnapshot> {
    const plan = normalizePlan(user.plan)
    const allowedUnits = await readQuotaPolicy(prisma, plan, feature)
    return { plan, feature, allowedUnits }
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* ویرایش ادمین                                                             */
/* ──────────────────────────────────────────────────────────────────────────── */

/** 400 — مقدار نامعتبر (مرز DB هم همین را تضمین می‌کند). */
export class InvalidQuotaPolicyError extends ServiceError {
    constructor(message: string) {
        super(400, "INVALID_QUOTA_POLICY", message, undefined, "VALIDATION", "WARNING")
    }
}

/**
 * تغییر سقف یک (plan × feature) توسط ادمین + ثبت audit.
 *
 * نکته‌ی مهم برای audit (تصمیم D5): چون BASE ظرفیتش از policy **زنده** خوانده
 * می‌شود، تغییر وسطِ ماه روی رفتارِ *دوره‌ی جاری* اثر می‌گذارد. این عمدی و پذیرفته‌شده
 * است؛ به همین دلیل `AiUsageEvent.policyAllowedUnits` در لحظه‌ی مصرف snapshot
 * می‌شود تا بعداً معلوم باشد هر عملیات زیر چه ظرفیتی انجام شده.
 *
 * تضمین «bucket crash نکند»: پایین آوردن سقف هیچ‌وقت داده را نمی‌شکند؛ bucket
 * فقط از ظرفیت جدید پیروی می‌کند و `reservedUnits/consumedUnits` دست‌نخورده می‌مانند.
 * یعنی اگر سقف از ۱۵ به ۵ برود و کاربر ۱۲ مصرف کرده باشد، ظرفیت باقی‌مانده منفی
 * «مصرف‌شده» تلقی نمی‌شود — رزرو بعدی فقط تا ۵ کل قفل است و شمارنده‌ها سالم می‌مانند.
 */
export async function updateQuotaPolicy(
    prisma: PrismaClientLike,
    input: {
        plan: UserPlan
        feature: AiFeature
        allowedUnits: number
        /** actor از requireAdmin() — نه از بدنه. */
        actorUserId: number
        requestId?: string
    },
): Promise<QuotaPolicySnapshot> {
    if (
        !Number.isInteger(input.allowedUnits) ||
        input.allowedUnits < 0 ||
        input.allowedUnits > 1_000_000
    ) {
        throw new InvalidQuotaPolicyError("سهمیه باید عدد صحیح بین ۰ و ۱۰۰۰۰۰۰ باشد")
    }

    let before: QuotaPolicySnapshot | null = null
    try {
        const existing = await prisma.aiQuotaPolicy.findUnique({
            where: { plan_feature: { plan: input.plan, feature: input.feature } },
            select: { plan: true, feature: true, allowedUnits: true },
        })
        before = (existing as QuotaPolicySnapshot | null) ?? null

        if (before) {
            await prisma.aiQuotaPolicy.update({
                where: { plan_feature: { plan: input.plan, feature: input.feature } },
                data: { allowedUnits: input.allowedUnits, updatedByUserId: input.actorUserId },
            })
        } else {
            // ردیف گمشده: به‌جای خطا، ایجادش می‌کنیم تا policy همیشه کامل بماند
            // (ساختار «دقیقاً ۴ ترکیب» در readQuotaPolicy enforce می‌شود).
            await prisma.aiQuotaPolicy.create({
                data: {
                    plan: input.plan,
                    feature: input.feature,
                    allowedUnits: input.allowedUnits,
                    updatedByUserId: input.actorUserId,
                },
            })
        }
    } catch (error) {
        if (error instanceof InvalidQuotaPolicyError) throw error
        throw new QuotaUnavailableError()
    }

    await writeAdminAuditLog(prisma, {
        actorUserId: input.actorUserId,
        action: "quota_policy.updated",
        targetType: "ai_quota_policy",
        targetId: `${input.plan}:${input.feature}`,
        before: before ? { allowedUnits: before.allowedUnits } : null,
        after: { allowedUnits: input.allowedUnits },
        requestId: input.requestId ?? null,
    })

    return { plan: input.plan, feature: input.feature, allowedUnits: input.allowedUnits }
}
