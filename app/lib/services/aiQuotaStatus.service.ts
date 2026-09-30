// AI Quota — وضعیت سهمیه برای نمایش به کاربر (read-only)
//
// این ماژول **هیچ قاعدهٔ quota جدیدی اختراع نمی‌کند**. تنها کاری که می‌کند این است که
// همان تصمیمی را که runtime می‌گیرد، برای نمایش هم بگیرد:
//
//   1) کدام ledger فعال است؟  → `readCutoverAt` + `resolveQuotaMode` (عین `runAiOperation`)
//   2) در آن ledger چقدر جا مانده؟ → خواندنِ همان شمارنده‌هایی که reserve می‌خواند
//
// ── چرا این فایل وجود دارد و چرا ریاضی در آن تکرار نشده ──────────────────────────
// مسیر V2 عمداً به `readQuotaBuckets` (همان تابعی که خودِ V2 برای خواندن وضعیت
// دارد) delegate می‌کند. یعنی «remaining» اینجا **همان** عددی است که رزرو بعدی با
// آن تصمیم می‌گیرد — نه یک تقریب موازی که ممکن است با قاعدهٔ واقعی واگرا شود.
//
// نکتهٔ کلیدی که در §۳ سند آمده و اینجا رعایت شده:
//     remaining ≠ granted - consumed
// چون رزروِ فعال (`reservedUnits`) هنوز قابل‌مصرف توسط درخواست‌های دیگر است و باید
// از «قابل استفاده» کم شود. `readQuotaBuckets` این را با
//     remaining = capacity - reserved - consumed
// محاسبه می‌کند و ما آن را عیناً تحویل می‌دهیم.
//
// ── چرا path Legacy هم وجود دارد ────────────────────────────────────────────────
// تا لحظه‌ای که دورهٔ جاری LEGACY است، `AiUsage` مرجع است — نه bucketها. اگر UI
// در آن بازه عددِ bucketها را نشان می‌داد، **عددِ غیرواقعی** نشان می‌داد (چون هیچ
// رزروی در bucket ثبت نشده و همه‌چیز ظرفیت‌پر به نظر می‌رسید). پس همان تصمیم
// legacy/V2 را می‌گیریم و از همان جدولی می‌خوانیم که runtime در آن حالت می‌نویسد.
//
// نکتهٔ مهم دربارهٔ legacy: در آن مسیر **یک استخر مشترک** بین analyze و plan وجود
// دارد (`reserveQuota` روی یک ردیف `AiUsage` رزرو می‌کند، بدون تفکیک feature). پس
// هر دو بُعد عمداً یکسان گزارش می‌شوند. ساختنِ دو عددِ جدا برای legacy یعنی نمایشِ
// چیزی که سیستم واقعاً enforce نمی‌کند.
//
// ── قواعد LOCKED ────────────────────────────────────────────────────────────────
// - **کاملاً read-only.** هیچ create/update/delete/transaction در این فایل نیست.
// - Fail-closed: خطای DB یا policy گمشده → `QuotaUnavailableError` (همان رفتار reserve).
// - سقف‌ها از `AiQuotaPolicy` زنده خوانده می‌شوند؛ هیچ عددی hard-code نشده.
// - PROMO فقط از راه bucketهای `grantedUnits` وارد می‌شود، و آن bucketها **فقط**
//   در `redeemPromoCode` ساخته/افزایش می‌یابند. پس کدِ redeem‌نشده به‌طور ذاتی در
//   این محاسبه نیست و لازم نیست جدول `PromoCode` اصلاً خوانده شود.
// - **در هر دو mode** (LEGACY و NEW) بونوس همان بُعد به `remaining` همان بُعد اضافه
//   می‌شود، چون enforcement در هر دو مسیر از همان bucket PROMO مصرف می‌کند. نمایش
//   نمی‌تواند از رزرو جلوتر یا عقب‌تر باشد.

import type { AiFeature } from "@prisma/client"

import { getMonthlyPeriod, resolvePlanPolicy } from "./planPolicy.service"
import { readCutoverAt, resolveQuotaMode, type QuotaMode } from "./aiQuotaCutover.service"
import {
    readPromoBucketView,
    readQuotaBuckets,
    type QuotaBucketView,
} from "./aiQuotaV2.service"
import { QuotaUnavailableError } from "./errors"
import type { PrismaClientLike } from "./aiUsage.service"

/** وضعیت یک بُعد سهمیه (ANALYZE یا PLAN) از دید کاربر. */
export interface AiQuotaDimensionStatus {
    /** آنچه واقعاً می‌تواند مصرف کند — شامل PROMO، و با رزروهای فعال کم‌شده. */
    remaining: number
    /** کل ظرفیت این دوره (BASE از policy + PROMO از grantedUnits). */
    granted: number
    /** مصرف نهایی‌شده (COMPLETE شده)؛ رزروهای آزادشده اینجا نیستند. */
    consumed: number
    /**
     * باقی‌ماندهٔ PROMO — فقط برای یک توضیح ظریف در UI («۲ مورد هدیه»).
     * عمداً جدا از `remaining` است تا به سهمیهٔ اصلی چسبانده نشود.
     */
    promoRemaining: number
}

export interface AiQuotaStatus {
    analyze: AiQuotaDimensionStatus
    plan: AiQuotaDimensionStatus
    /**
     * کدام ledger در این لحظه authoritative است. سراسری و غیرحساس است (نه دادهٔ
     * کاربر) و برای تشخیص/دیباگ مفید است؛ UI لازمش ندارد.
     */
    mode: QuotaMode
    /** شروع دورهٔ فعال به ISO — برای تشخیص rollover، بدون دادهٔ حساس. */
    periodStart: string
}

export interface ReadAiQuotaStatusInput {
    /** از session — هرگز از query/body. */
    userId: number
    /** پلن مؤثر و سرور-محور از `getCurrentUser()` (نه `User.plan` آینه‌ای). */
    plan: string | null | undefined
    timezone: string
    now?: Date
}

/**
 * readAiQuotaStatus — وضعیت هر دو بُعد سهمیهٔ کاربر در دورهٔ فعال.
 *
 * Fail-closed: هر خطای DB → `QuotaUnavailableError`. UI در آن حالت بهتر است چیزی
 * نشان ندهد تا عددِ غلط نشان دهد.
 */
export async function readAiQuotaStatus(
    prisma: PrismaClientLike,
    input: ReadAiQuotaStatusInput,
): Promise<AiQuotaStatus> {
    const now = input.now ?? new Date()
    const periodStart = getMonthlyPeriod(now, input.timezone).periodStart

    // همان تصمیمی که `runAiOperation` می‌گیرد — نه یک نسخهٔ موازی.
    const cutoverAt = await readCutoverAt(prisma)
    const mode = resolveQuotaMode(periodStart, cutoverAt, input.timezone)

    const dimensions =
        mode === "NEW"
            ? await readV2Dimensions(prisma, input, periodStart)
            : await readLegacyDimensions(prisma, input, periodStart)

    return {
        analyze: dimensions.analyze,
        plan: dimensions.plan,
        mode,
        periodStart: periodStart.toISOString(),
    }
}

/**
 * دورهٔ V2 — از همان `readQuotaBuckets` استفاده می‌کنیم که خودِ ledger از آن
 * استفاده می‌کند، پس ریاضیِ remaining اینجا **duplicate نمی‌شود**.
 */
async function readV2Dimensions(
    prisma: PrismaClientLike,
    input: ReadAiQuotaStatusInput,
    periodStart: Date,
): Promise<{ analyze: AiQuotaDimensionStatus; plan: AiQuotaDimensionStatus }> {
    const views = await readQuotaBuckets(prisma, {
        userId: input.userId,
        plan: input.plan,
        timezone: input.timezone,
        now: input.now,
    })

    const pick = (feature: AiFeature): AiQuotaDimensionStatus => {
        const base = views.find((v) => v.feature === feature && v.source === "BASE")
        const promo = views.find((v) => v.feature === feature && v.source === "PROMO")

        if (!base || !promo) throw new QuotaUnavailableError()

        return {
            // remaining هر منبع جدا حساب شده و اینجا جمع می‌شود: یعنی دقیقاً
            // «آنچه کاربر واقعاً می‌تواند مصرف کند» (BASE + PROMO).
            remaining: base.remaining + promo.remaining,
            granted: base.capacity + promo.capacity,
            consumed: base.consumed + promo.consumed,
            promoRemaining: promo.remaining,
        }
    }

    return { analyze: pick("ANALYZE"), plan: pick("PLAN") }
}

/**
 * دورهٔ legacy — مرجع، همان `AiUsage` است.
 *
 * سقف از `resolvePlanPolicy` می‌آید، نه از جدول `AiQuotaPolicy`: در دورهٔ legacy
 * اصلاً reserve روی policy خوانده نمی‌شود (`runAiOperation` هم `resolvePlanPolicy`
 * را صدا می‌زند)، پس نشان دادن سقفِ policy در این بازه **عددِ ساختگی** می‌بود.
 *
 * همان فرمول invariant استفاده می‌شود: capacity - reserved - consumed.
 *
 * ── سهمیهٔ هدیه (PROMO) در legacy ───────────────────────────────────────────
 * استخرِ legacy یک ردیفِ **مشترک** بدون تفکیک بُعد است، اما هر بُعد سخت‌افزارِ
 * خودش را دارد: `AiQuotaBucket(source="PROMO", feature=...)` که `redeemPromoCode`
 * در همان `periodStart` پر می‌کند و `reserveQuota` از آن مصرف می‌کند. پس برای اینکه
 * نمایش با enforcement **عیناً یکی** باشد (وگرنه UI می‌گوید هست و reserve می‌گوید
 * نیست)، PROMO هم خوانده و به remaining همان بُعد اضافه می‌شود:
 *
 *   remaining = max(0, base_remaining) + promo_remaining
 *
 * جمع «دو بُعد» نیست: مصرف ANALYZE از سهمیهٔ PLAN کم نمی‌کند (همان قرارداد V2)،
 * پس هر بُعد فقط بونوسِ خودش را می‌بیند. بونوسِ دورهٔ قبل اصلاً خوانده نمی‌شود،
 * چون کلید خواندن همان `periodStart` جاریِ کاربر است.
 *
 * `@param periodStart` نگه داشته شده برای هم‌راستایی با مسیر V2 و برای تست‌پذیری؛
 * در legacy از طریق کلید composite خوانده می‌شود.
 */
async function readLegacyDimensions(
    prisma: PrismaClientLike,
    input: ReadAiQuotaStatusInput,
    periodStart: Date,
): Promise<{ analyze: AiQuotaDimensionStatus; plan: AiQuotaDimensionStatus }> {
    const allowedUnits = resolvePlanPolicy({ plan: input.plan }).allowedUnits

    let reserved = 0
    let consumed = 0
    try {
        const row = await prisma.aiUsage.findUnique({
            where: {
                userId_periodType_periodStart: {
                    userId: input.userId,
                    periodType: "MONTHLY",
                    periodStart,
                },
            },
            select: { reservedUnits: true, consumedUnits: true },
        })
        reserved = row?.reservedUnits ?? 0
        consumed = row?.consumedUnits ?? 0
    } catch {
        throw new QuotaUnavailableError()
    }

    const baseRemaining = Math.max(0, allowedUnits - reserved - consumed)

    // Fail-closed درست مثل بقیهٔ مسیر: خطای DB ⇒ کل status خطا، نه «PROMO = صفر».
    const [analyzePromo, planPromo] = await Promise.all([
        readPromoBucketView(prisma, { userId: input.userId, feature: "ANALYZE", periodStart }),
        readPromoBucketView(prisma, { userId: input.userId, feature: "PLAN", periodStart }),
    ])

    /** یک استخر مشترک BASE بین دو بُعد، + بونوسِ مستقلِ همان بُعد. */
    const dimension = (promo: QuotaBucketView): AiQuotaDimensionStatus => ({
        // چون PROMO جدا حساب می‌شود و بعد جمع می‌گردد، هرگز دوبار شمرده نمی‌شود:
        // `baseRemaining` فقط از `AiUsage` می‌آید و `promo.remaining` فقط از bucket PROMO.
        remaining: baseRemaining + promo.remaining,
        granted: allowedUnits + promo.capacity,
        consumed: consumed + promo.consumed,
        promoRemaining: promo.remaining,
    })

    return { analyze: dimension(analyzePromo), plan: dimension(planPromo) }
}
