// AI Quota v2 — Promo Code: ساخت (ادمین) و ریدیمپشن (کاربر) — Phase 2
//
// قواعد LOCKED:
// - `validFrom`/`expiresAt` **فقط پنجره‌ی ریدیمپشن** را کنترل می‌کنند. بعد از
//   redeem، bonus به‌صورت snapshot در `PromoRedemption` و در bucket PROMO می‌نشیند
//   و تا پایان همان quota period معتبر می‌ماند — حتی اگر کد بعداً expire شود.
//   `bonusExpiresAt` عمداً وجود ندارد.
// - هر کاربر هر کد را **فقط یک‌بار** (UNIQUE(userId, promoCodeId) در سطح DB).
// - `maxRedemptions` با **CAS** روی `redeemedCount` در همان transaction اجرا می‌شود:
//     UPDATE ... WHERE id = ? AND redeemedCount < maxRedemptions → row count 0 یعنی تمام.
//   این یک UPDATE اتمیک است، پس هیچ lost update‌ای ممکن نیست؛ `redeemedCount` هرگز
//   از سقف عبور نمی‌کند.
// - `grantedUnits += bonus` هم **اتمیک** است: همان upsert با `increment`، در همان
//   transaction. چند promo متفاوتِ همزمانِ یک کاربر جمع درست می‌دهند.
// - redemption و grant اولیه **transactionally consistent** هستند: هر شکستی کل
//   transaction (شامل increment شدن `redeemedCount`) را rollback می‌کند.
// - سهمیه‌ی promo **جدا** از base است: bucket جدا با `source = PROMO`.
// - **کلاینت هرگز bonus/units/userId/plan را تعیین نمی‌کند** — ورودی redeems فقط
//   `{ code }` است و snapshot از خودِ ردیف کد می‌آید.

import type { PromoCode } from "@prisma/client"

import { writeAdminAuditLog } from "./adminAudit.service"
import { resolveQuotaWindowFor } from "./quotaWindow"
import { QuotaUnavailableError, ServiceError } from "./errors"
import { normalizePromoCode } from "@/app/schema/aiQuotaSchema"
import type { PrismaClientLike } from "./aiUsage.service"

/* ──────────────────────────────────────────────────────────────────────────── */
/* خطاها                                                                    */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * پاسخ **عمومی و یکسان** برای همه‌ی حالت‌هایی که وجود کد را افشا می‌کنند.
 *
 * تصمیم قطعی ضد-enumeration: «پیدا نشد» / «غیرفعال» / «هنوز معتبر نشده» / «منقضی» /
 * «ظرفیت تمام» — **همه** دقیقاً همین یک کد و همین یک پیام را برمی‌گردانند
 * (`PROMO_CODE_INVALID`). عملاً `PROMO_EXHAUSTED` حذف شده است: «تمام بودن ظرفیت»
 * هم وجودِ کد را ثابت می‌کرد و با یک `findUnique` ارزان قابل کشف بود.
 *
 * چرا این امن است: کدهای promo می‌توانند دستی توسط ادمین وارد شوند، پس هیچ
 * تضمین entropyای وجود ندارد. بنابراین **امنیت به غیرقابل‌پیش‌بینی‌بودن کد وابسته
 * نیست**؛ دفاع اصلی، پاسخ یکسان + rate limit است (هر دو مستقل از entropy کد).
 *
 * جزئیات واقعی فقط **سمت سرور** ثبت می‌شود (audit پایین) و هرگز به کلاینت نمی‌رود.
 */
export class PromoCodeInvalidError extends ServiceError {
    constructor() {
        super(
            400,
            "PROMO_CODE_INVALID",
            "کد هدیه معتبر نیست",
            undefined,
            "VALIDATION",
            "INFO",
        )
    }
}

/** 409 — همین کاربر قبلاً این کد را استفاده کرده. افشا نمی‌کند چیزی که خودِ کاربر نمی‌داند. */
export class PromoAlreadyRedeemedError extends ServiceError {
    constructor() {
        super(
            409,
            "PROMO_ALREADY_REDEEMED",
            "این کد هدیه را قبلاً استفاده کرده‌اید",
            undefined,
            "CONFLICT",
            "INFO",
        )
    }
}

/**
 * دلیل **واقعی** رد ریدیمپشن — فقط سمت سرور، فقط برای audit.
 *
 * این مقدار هرگز در پاسخ HTTP ظاهر نمی‌شود؛ کلاینت فقط `PROMO_CODE_INVALID` (یا
 * `PROMO_ALREADY_REDEEMED`) می‌بیند. وجود همین تفکیک یعنی پشتیبانی/ادمین می‌تواند
 * بفهمد چرا یک کد کار نمی‌کند، بدون آنکه endpoint قابلیت enumeration بدهد.
 */
export type PromoRejectionReason =
    | "INVALID"
    | "INACTIVE"
    | "NOT_YET_VALID"
    | "EXPIRED"
    | "EXHAUSTED"
    | "ALREADY_REDEEMED"

/** 400 — ورودی ساخت کد نامعتبر (تکرار لایه‌ی Zod برای فراخوانی مستقیم سرویس). */
export class InvalidPromoCodeError extends ServiceError {
    constructor(message: string) {
        super(400, "INVALID_PROMO_CODE", message, undefined, "VALIDATION", "WARNING")
    }
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* ساخت کد (ادمین)                                                          */
/* ──────────────────────────────────────────────────────────────────────────── */

export interface CreatePromoCodeInput {
    code: string
    isActive?: boolean
    validFrom: Date
    expiresAt: Date
    maxRedemptions?: number | null
    bonusAnalyzeUnits: number
    bonusPlanUnits: number
    /** از requireAdmin() — نه از بدنه. */
    actorUserId: number
    requestId?: string
}

/** ثابت‌های schema-agnostic که مستقیم در DB هم enforce می‌شوند (CHECKها). */
const MAX_BONUS_UNITS = 100_000

export async function createPromoCode(
    prisma: PrismaClientLike,
    input: CreatePromoCodeInput,
): Promise<PromoCode> {
    const code = normalizePromoCode(input.code)

    if (code.length < 3 || code.length > 64) {
        throw new InvalidPromoCodeError("کد هدیه نامعتبر است")
    }
    if (!(input.expiresAt.getTime() > input.validFrom.getTime())) {
        throw new InvalidPromoCodeError("زمان پایان باید بعد از زمان شروع باشد")
    }
    if (input.maxRedemptions != null && (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1)) {
        throw new InvalidPromoCodeError("سقف ریدیمپشن باید حداقل ۱ باشد")
    }
    for (const bonus of [input.bonusAnalyzeUnits, input.bonusPlanUnits]) {
        if (!Number.isInteger(bonus) || bonus < 0 || bonus > MAX_BONUS_UNITS) {
            throw new InvalidPromoCodeError("مقدار بونوس نامعتبر است")
        }
    }
    if (input.bonusAnalyzeUnits + input.bonusPlanUnits < 1) {
        throw new InvalidPromoCodeError("حداقل یک واحد بونوس لازم است")
    }

    let created: PromoCode
    try {
        created = await prisma.promoCode.create({
            data: {
                code,
                isActive: input.isActive ?? true,
                validFrom: input.validFrom,
                expiresAt: input.expiresAt,
                maxRedemptions: input.maxRedemptions ?? null,
                bonusAnalyzeUnits: input.bonusAnalyzeUnits,
                bonusPlanUnits: input.bonusPlanUnits,
                createdByUserId: input.actorUserId,
            },
        })
    } catch (error) {
        // کد تکراری → 409 عمومیِ «قبلاً ثبت شده» (همان mapping استاندارد پروژه)
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002") {
            throw new ServiceError(409, "CONFLICT", "این مقدار قبلاً ثبت شده است")
        }
        throw new QuotaUnavailableError()
    }

    await writeAdminAuditLog(prisma, {
        actorUserId: input.actorUserId,
        action: "promo.created",
        targetType: "promo_code",
        targetId: created.id,
        after: {
            code: created.code,
            isActive: created.isActive,
            bonusAnalyzeUnits: created.bonusAnalyzeUnits,
            bonusPlanUnits: created.bonusPlanUnits,
            maxRedemptions: created.maxRedemptions,
        },
        requestId: input.requestId ?? null,
    })

    return created
}

export interface PromoCodeListItem {
    id: string
    code: string
    isActive: boolean
    validFrom: Date
    expiresAt: Date
    maxRedemptions: number | null
    bonusAnalyzeUnits: number
    bonusPlanUnits: number
    redeemedCount: number
    createdAt: Date
}

/** فهرست کدها برای ادمین (هر ردیف bonus خودش را دارد، نه مجموع آن). */
export async function listPromoCodes(prisma: PrismaClientLike): Promise<PromoCodeListItem[]> {
    try {
        return await prisma.promoCode.findMany({
            select: {
                id: true,
                code: true,
                isActive: true,
                validFrom: true,
                expiresAt: true,
                maxRedemptions: true,
                bonusAnalyzeUnits: true,
                bonusPlanUnits: true,
                redeemedCount: true,
                createdAt: true,
            },
            orderBy: { createdAt: "desc" },
        })
    } catch {
        throw new QuotaUnavailableError()
    }
}

/** فعال/غیرفعال کردن یک کد + audit. */
export async function setPromoCodeActive(
    prisma: PrismaClientLike,
    input: { promoCodeId: string; isActive: boolean; actorUserId: number; requestId?: string },
): Promise<boolean> {
    try {
        const updated = await prisma.promoCode.updateMany({
            where: { id: input.promoCodeId },
            data: { isActive: input.isActive },
        })
        if (updated.count === 0) return false
    } catch {
        throw new QuotaUnavailableError()
    }

    await writeAdminAuditLog(prisma, {
        actorUserId: input.actorUserId,
        action: "promo.updated",
        targetType: "promo_code",
        targetId: input.promoCodeId,
        after: { isActive: input.isActive },
        requestId: input.requestId ?? null,
    })
    return true
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* ریدیمپشن (کاربر)                                                          */
/* ──────────────────────────────────────────────────────────────────────────── */

export interface RedeemPromoCodeInput {
    /** از session — هرگز از بدنه. */
    userId: number
    /** تنها ورودی کلاینت. */
    code: string
    /** timezone کاربر برای تعیین periodStart. */
    timezone: string
    now?: Date
    /** فقط برای audit؛ از observability context. */
    requestId?: string | null
}

export interface RedeemPromoCodeResult {
    promoCodeId: string
    periodStart: Date
    /** بونوس‌های snapshot‌شده — فقط همین‌ها به bucket اضافه می‌شوند. */
    bonusAnalyzeUnits: number
    bonusPlanUnits: number
    /** بُعدهایی که واقعاً grant شدند (بونوس صفر → بدون ساخت bucket). */
    grantedFeatures: ("ANALYZE" | "PLAN")[]
}

/** حداکثر تلاش برای برخورد با unique key در upsert bucket (اولین رزرو هم‌زمان). */
const GRANT_MAX_ATTEMPTS = 3

/* ──────────────────────────────────────────────────────────────────────────── */
/* کانال audit سمت سرور (ضد-enumeration)                                       */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * سیگنال **داخلی و غیرعمومی** برای «ظرفیت تمام».
 *
 * عمداً `ServiceError` نیست و هرگز از سرویس بیرون نمی‌رود: بلافاصله در حلقه‌ی
 * retry گرفته می‌شود، audit می‌شود و به `PromoCodeInvalidError` (عمومی) تبدیل
 * می‌گردد. اگر نشت کند، `catch` پایین آن را به `QuotaUnavailableError` تبدیل
 * می‌کند — یعنی fail-closed، بدون افشا.
 */
class PromoExhaustedSignal extends Error {
    constructor() {
        super("promo capacity exhausted")
        this.name = "PromoExhaustedSignal"
    }
}

/**
 * ثبت دلیل واقعیِ رد ریدیمپشن — **سمت سرور فقط** — و برگرداندن پاسخ عمومی.
 *
 * این تنها جایی است که `INVALID` / `INACTIVE` / `NOT_YET_VALID` / `EXPIRED` /
 * `EXHAUSTED` از هم جدا می‌شوند. کلاینت در همه‌ی این حالت‌ها فقط
 * `PROMO_CODE_INVALID` می‌بیند.
 *
 * چرا `AdminAuditLog`: جدول append-only است، FK به User ندارد (پس حذف کاربر ردِ
 * audit را از بین نمی‌برد) و از قبل برای quota/promo استفاده می‌شود. نوشتن آن
 * best-effort است — یک ریدیمپشن نباید فقط به‌خاطر خرابی audit شکست بخورد.
 *
 * `code` عمداً snapshot نمی‌شود: شناسه/هنگام کافی است و ثبت متنِ کد، کدهای
 * نامعتبرِ ارسالیِ مهاجم را بی‌دلیل ذخیره می‌کرد.
 */
async function recordPromoRejection(
    prisma: PrismaClientLike,
    input: {
        reason: PromoRejectionReason
        userId: number
        promoCodeId: string | null
        requestId?: string | null
    },
): Promise<void> {
    await writeAdminAuditLog(prisma, {
        actorUserId: input.userId,
        action: "promo.redeem_rejected",
        targetType: "promo_code",
        targetId: input.promoCodeId ?? "-",
        // `after` تنها جایی است که دلیل واقعی ثبت می‌شود (نه در response).
        after: { reason: input.reason },
        requestId: input.requestId ?? null,
    })
}

/**
 * wrapper رد: اول دلیل واقعی را audit می‌کند، بعد **پاسخ عمومی** را برمی‌گرداند
 * تا caller آن را throw کند.
 *
 * چرا `Promise<never>` نیست: TypeScript بعد از `await` روی `Promise<never>`
 * تنگ‌شدن (narrowing) انجام نمی‌دهد، پس `promo` تا آخر `PromoCode | null`
 * می‌ماند و کل فایل ۱۱ خطای «possibly null» می‌گیرد. با برگرداندن خطا، خودِ
 * `throw` در همان scope می‌ماند و narrowing درست کار می‌کند.
 *
 * تضمین قرارداد: همه‌ی این دلایل دقیقاً **یک** پاسخ عمومی می‌سازند، پس تفکیک
 * فقط در audit باقی می‌ماند.
 */
async function rejectionResponse(
    prisma: PrismaClientLike,
    input: {
        reason: Exclude<PromoRejectionReason, "ALREADY_REDEEMED">
        userId: number
        promoCodeId: string | null
        requestId?: string | null
    },
): Promise<ServiceError> {
    await recordPromoRejection(prisma, input)
    return new PromoCodeInvalidError()
}

/**
 * redeemPromoCode — ریدیمپشن اتمیک + grant اولیه.
 *
 * ترتیب داخل transaction (همه‌ی این‌ها یا هیچ‌کدام):
 *   1. CAS روی `redeemedCount` با guard سقف  → اگر 0 ردیف، سقف تمام است.
 *   2. ساخت `PromoRedemption` (UNIQUE(userId, promoCodeId)) → تکراری = AlreadyRedeemed.
 *   3. برای هر بُعدی که بونوس > 0 دارد: upsert bucket PROMO با `grantedUnits += bonus`.
 *   4. ساخت ردیف‌های PROMO با بونوس صفر عمداً انجام **نمی‌شود** (صدا بی‌فایده؛
 *      نبودن bucket در مصرف = ظرفیت صفر، که همان معنای درست است).
 *
 * چرا بررسی پنجره/فعال‌بودن *قبل* از transaction است: این‌ها خواندن‌های فقط‌خواندنی‌اند
 * و در هر حال داخل transaction دوباره معتبر می‌مانند (مقادیر immutable‌اند و CAS
 * روی شمارنده، تغییر هم‌زمانِ سقف را می‌گیرد).
 *
 * ── ضد-enumeration ──────────────────────────────────────────────────────────
 * همه‌ی حالت‌های رد (پیدا نشد / غیرفعال / هنوز معتبر نشده / منقضی / ظرفیت تمام) به
 * کلاینت **یک پاسخ یکسان** می‌دهند: `PROMO_CODE_INVALID`. دلیل واقعی فقط در
 * `AdminAuditLog` ثبت می‌شود. تنها استثنا `PROMO_ALREADY_REDEEMED` است که به
 * کاربری برمی‌گردد که خودش قبلاً همان کد را ریدیم کرده، پس oracle عمومی نیست.
 *
 * ── محدودیت شناخته‌شده ───────────────────────────────────────────────────────
 * `isRateLimited` in-memory است؛ روی Vercel (سرورهای بدون حالت) هر نمونه Map
 * خودش را دارد، پس سقف مؤثر تعداد نمونه‌ها × نرخ است. endpoint ریدیمپشن باید هم
 * per-user و هم per-IP محدود شود. جایگزین (Upstash/Redis) آگاهانه به فاز بعد موکول
 * شده — نه چون کم‌اهمیت است، بلکه چون در این فاز dependency جدید اضافه نمی‌شود.
 */
export async function redeemPromoCode(
    prisma: PrismaClientLike,
    input: RedeemPromoCodeInput,
): Promise<RedeemPromoCodeResult> {
    const now = input.now ?? new Date()
    const normalized = normalizePromoCode(input.code)

    // 1) کد وجود دارد؟ (پاسخ عمومی در همه‌ی حالت‌های نامعتبر)
    let promo: PromoCode | null = null
    try {
        promo = await prisma.promoCode.findUnique({
            where: { code: normalized },
        })
    } catch {
        throw new QuotaUnavailableError()
    }
    if (!promo) {
        throw await rejectionResponse(prisma, {
            reason: "INVALID",
            userId: input.userId,
            promoCodeId: null,
            requestId: input.requestId,
        })
    }

    // 2) فعال + در پنجره‌ی ریدیمپشن — هر سه دقیقاً مثل «پیدا نشد» به کلاینت می‌رسند
    if (!promo.isActive) {
        throw await rejectionResponse(prisma, {
            reason: "INACTIVE",
            userId: input.userId,
            promoCodeId: promo.id,
            requestId: input.requestId,
        })
    }
    if (now.getTime() < promo.validFrom.getTime()) {
        throw await rejectionResponse(prisma, {
            reason: "NOT_YET_VALID",
            userId: input.userId,
            promoCodeId: promo.id,
            requestId: input.requestId,
        })
    }
    if (now.getTime() >= promo.expiresAt.getTime()) {
        throw await rejectionResponse(prisma, {
            reason: "EXPIRED",
            userId: input.userId,
            promoCodeId: promo.id,
            requestId: input.requestId,
        })
    }

    // 3) قبلاً استفاده نشده باشد (بررسی سریع؛ مرجع نهایی UNIQUE دیتابیس است)
    //    این تنها حالتی است که پاسخ متمایز دارد — چون فقط خودِ کاربر می‌داند.
    try {
        const existing = await prisma.promoRedemption.findUnique({
            where: { userId_promoCodeId: { userId: input.userId, promoCodeId: promo.id } },
            select: { id: true },
        })
        if (existing) {
            await recordPromoRejection(prisma, {
                reason: "ALREADY_REDEEMED",
                userId: input.userId,
                promoCodeId: promo.id,
                requestId: input.requestId,
            })
            throw new PromoAlreadyRedeemedError()
        }
    } catch (error) {
        if (error instanceof PromoAlreadyRedeemedError) throw error
        throw new QuotaUnavailableError()
    }

    // بونوس به **دورهٔ جاری کاربر** تعلق می‌گیرد (لنگر اشتراک/کاربر)، نه اولِ ماه تقویمی؛
    // پس در پایان همان دوره منقضی می‌شود و طبق تصمیم محصول به دورهٔ بعد منتقل نمی‌شود.
    const periodStart = (
        await resolveQuotaWindowFor(prisma, {
            userId: input.userId,
            now,
            timezone: input.timezone,
        })
    ).periodStart
    const maxRedemptions = promo.maxRedemptions

    // 4) transaction: CAS سقف + ساخت ریدیمپشن + grant اتمیک bucket
    for (let attempt = 0; attempt < GRANT_MAX_ATTEMPTS; attempt++) {
        try {
            return await prisma.$transaction(async (tx: any) => {
                // 4a) CAS شمارنده — یک UPDATE اتمیک با guard سقف.
                const claimed = await tx.promoCode.updateMany({
                    where: {
                        id: promo!.id,
                        ...(maxRedemptions != null ? { redeemedCount: { lt: maxRedemptions } } : {}),
                    },
                    data: { redeemedCount: { increment: 1 } },
                })
                // ظرفیت تمام. سیگنال داخلی تا transaction rollback شود؛ audit و
                // پاسخ عمومی **بیرون** از callback نوشته/پرتاب می‌شوند تا نه در
                // transaction شماره‌خورده نماند و نه nested transaction لازم شود.
                if (claimed.count === 0) throw new PromoExhaustedSignal()

                // 4b) ریدیمپشن (UNIQUE(userId, promoCodeId) مرجع نهایی ضدتکرار است)
                await tx.promoRedemption.create({
                    data: {
                        promoCodeId: promo!.id,
                        userId: input.userId,
                        bonusAnalyzeUnits: promo!.bonusAnalyzeUnits,
                        bonusPlanUnits: promo!.bonusPlanUnits,
                        periodStart,
                    },
                })

                // 4c) grant اتمیک به bucket PROMO هر بُعدِ دارای بونوس
                const grantedFeatures: ("ANALYZE" | "PLAN")[] = []
                if (promo!.bonusAnalyzeUnits > 0) {
                    await incrementPromoGrant(tx, input.userId, "ANALYZE", periodStart, promo!.bonusAnalyzeUnits)
                    grantedFeatures.push("ANALYZE")
                }
                if (promo!.bonusPlanUnits > 0) {
                    await incrementPromoGrant(tx, input.userId, "PLAN", periodStart, promo!.bonusPlanUnits)
                    grantedFeatures.push("PLAN")
                }

                return {
                    promoCodeId: promo!.id,
                    periodStart,
                    bonusAnalyzeUnits: promo!.bonusAnalyzeUnits,
                    bonusPlanUnits: promo!.bonusPlanUnits,
                    grantedFeatures,
                }
            })
        } catch (error) {
            if (isDomainError(error)) throw error

            // ظرفیت تمام ⇒ audit سمت سرور + پاسخ عمومیِ یکسان با «کد نامعتبر».
            if (error instanceof PromoExhaustedSignal) {
                await recordPromoRejection(prisma, {
                    reason: "EXHAUSTED",
                    userId: input.userId,
                    promoCodeId: promo.id,
                    requestId: input.requestId,
                })
                throw new PromoCodeInvalidError()
            }

            // برخورد با UNIQUE روی (userId, promoCodeId) ⇒ ریدیمپشن هم‌زمانِ همان کاربر
            if (isUniqueViolation(error)) {
                const mine = await hasRedemption(prisma, input.userId, promo.id)
                if (mine) {
                    await recordPromoRejection(prisma, {
                        reason: "ALREADY_REDEEMED",
                        userId: input.userId,
                        promoCodeId: promo.id,
                        requestId: input.requestId,
                    })
                    throw new PromoAlreadyRedeemedError()
                }
                // وگرنه برخورد با unique keyِ bucket بوده → دور بعد (اولین رزروِ هم‌زمان)
                if (attempt < GRANT_MAX_ATTEMPTS - 1) continue
            }
            throw new QuotaUnavailableError()
        }
    }

    throw new QuotaUnavailableError()
}

/**
 * `grantedUnits += bonus` اتمیک روی bucket PROMO.
 *
 * `update: { grantedUnits: { increment } }` در سطح SQL یک UPDATE اتمیک است، پس
 * ریدیمپشن‌های هم‌زمانِ چند کد مختلف روی یک کاربر هرگز یکدیگر را نمی‌نویسند و
 * مجموع نهایی دقیقاً برابر مجموع بونوس‌هاست.
 */
async function incrementPromoGrant(
    tx: any,
    userId: number,
    feature: "ANALYZE" | "PLAN",
    periodStart: Date,
    bonus: number,
): Promise<void> {
    await tx.aiQuotaBucket.upsert({
        where: {
            userId_feature_source_periodType_periodStart: {
                userId,
                feature,
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart,
            },
        },
        create: {
            userId,
            feature,
            source: "PROMO",
            periodType: "MONTHLY",
            periodStart,
            grantedUnits: bonus,
        },
        update: { grantedUnits: { increment: bonus } },
    })
}

async function hasRedemption(
    prisma: PrismaClientLike,
    userId: number,
    promoCodeId: string,
): Promise<boolean> {
    try {
        const row = await prisma.promoRedemption.findUnique({
            where: { userId_promoCodeId: { userId, promoCodeId } },
            select: { id: true },
        })
        return row !== null && row !== undefined
    } catch {
        return false
    }
}

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "P2002"
    )
}

function isDomainError(error: unknown): boolean {
    return (
        error instanceof PromoAlreadyRedeemedError ||
        error instanceof PromoCodeInvalidError
    )
}
