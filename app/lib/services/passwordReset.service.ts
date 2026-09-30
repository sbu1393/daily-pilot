// رمز عبور موقت — صدور، اعتبارسنجی و مصرف.
//
// قواعد امنیتی (LOCKED):
// - **plaintext رمز موقت هرگز persist یا log نمی‌شود**؛ فقط bcrypt hash (هم‌راستا با
//   `OtpCode.codeHash` و `lib/otp.ts`).
// - `User.password` دست‌نخورده می‌ماند تا رمز دائمی قبلی سالم باشد؛ به همین دلیل
//   lifecycle در جدول جدا (`PasswordResetToken`) است، نه روی User.
// - هر درخواست جدید، توکن‌های باز قبلی همان کاربر را `invalidatedAt` می‌گیرد
//   (supersede) — پس قدیمی‌ترین رمز موقت همیشه بی‌اثر است.
// - مصرف **اتمیک** است: `DELETE ... WHERE id = ?` داخل همان تراکنشی که رمز دائمی
//   را می‌نویسد. دو درخواست همزمان: اولی حذف می‌کند، دومی `count === 0` می‌گیرد و
//   `P2002`/count-0 را به «توکن نامعتبر» تبدیل می‌کند (الگوی `promoCode.service.ts`).
// - خطاهای دامنه همگی به یک پاسخ عمومی می‌رسند تا مسیر لاگین oracle نسازد.
//
// نقش این سرویس: **فقط lifecycle توکن**. ارسال ایمیل و نوشتن `User.password` در
// لایه‌های بالاتر انجام می‌شود تا این سرویس single-purpose بماند (ADR-02).

import bcrypt from "bcryptjs"

import { getPrisma } from "@/app/lib/getPrisma"
import { generateTemporaryPassword } from "@/lib/temporaryPassword"
import { ServiceError } from "./errors"

const BCRYPT_COST = 12

/** TTL رمز موقت — هم‌راستا با `OTP_TTL_MS` و متن ایمیل. */
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000

/** سقف تلاش برای هر توکن (ضد brute force روی خودِ رمز موقت). */
export const PASSWORD_RESET_MAX_ATTEMPTS = 5

/** سقف پویا ساخته‌شده هنگام صدور. */
export const DEFAULT_RESET_MAX_ATTEMPTS = PASSWORD_RESET_MAX_ATTEMPTS

/**
 * کلاینت حداقلی موردنیاز — تزریق‌پذیر برای تست بدون DB واقعی.
 *
 * `any` به‌جای `unknown` عمدی است: این سرویس داخل تراکنش Prisma اجرا می‌شود و
 * شکل واقعی داده را خودِ Prisma تعیین می‌کند؛ این interface فقط مانعِ
 * وابستگی لایهٔ دامنه به کد تولیدشدهٔ Prisma است (همان قراردادی که
 * `promoCode.service.ts` با `tx: any` دارد).
 */
export interface PasswordResetClient {
    user: {
        findUnique: (args: unknown) => Promise<any>
        update: (args: unknown) => Promise<any>
    }
    passwordResetToken: {
        create: (args: unknown) => Promise<any>
        updateMany: (args: unknown) => Promise<{ count: number }>
        findFirst: (args: unknown) => Promise<any>
        findMany: (args: unknown) => Promise<any[]>
        deleteMany: (args: unknown) => Promise<{ count: number }>
        delete: (args: unknown) => Promise<any>
    }
}

export interface IssuedTemporaryPassword {
    /** رمز خام — فقط برای ارسال در ایمیل. هرگز persist یا log نمی‌شود. */
    temporaryPassword: string
    tokenId: string
    expiresAt: Date
}

/**
 * invalidateActiveTokensForUser — همهٔ توکن‌های باز کاربر را می‌بندد.
 *
 * قبل از صدور هر رمز موقت جدید صدا زده می‌شود تا فقط **آخرین** رمز موقت معتبر
 * باشد. این کار هم replay را می‌بندد و هم جلوی انباشت توکن را می‌گیرد.
 */
export async function invalidateActiveTokensForUser(
    prisma: PasswordResetClient,
    userId: number,
    now: Date = new Date(),
): Promise<number> {
    const result = await prisma.passwordResetToken.updateMany({
        where: { userId, usedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
    })
    return result.count
}

/**
 * issueTemporaryPassword — یک رمز موقت تازه می‌سازد، توکن‌های قبلی را باطل می‌کند
 * و هش رمز جدید را ذخیره می‌کند.
 *
 * فقط وقتی صدا زده می‌شود که کاربر **واقعاً وجود داشته باشد**؛ فراخوانی برای ایمیل
 * ناموجود انجام نمی‌شود (مسیر route مسئول پاسخ یکسان است، نه این سرویس).
 */
export async function issueTemporaryPassword(
    prisma: PasswordResetClient,
    input: { userId: number; now?: Date },
): Promise<IssuedTemporaryPassword> {
    const now = input.now ?? new Date()

    await invalidateActiveTokensForUser(prisma, input.userId, now)

    const temporaryPassword = generateTemporaryPassword()
    const tokenHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST)
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS)

    const record: { id: string } = await prisma.passwordResetToken.create({
        data: {
            userId: input.userId,
            tokenHash,
            maxAttempts: DEFAULT_RESET_MAX_ATTEMPTS,
            expiresAt,
        },
        select: { id: true },
    })

    return { temporaryPassword, tokenId: record.id, expiresAt }
}

/** ردیف توکن به‌شکل خامی که سرویس لازم دارد. */
export interface ActiveResetTokenRow {
    id: string
    tokenHash: string
    attempts: number
    maxAttempts: number
    expiresAt: Date
    usedAt: Date | null
    invalidatedAt: Date | null
}

/**
 * findActiveTokenForUser — تازه‌ترین توکن باز کاربر.
 *
 * عمداً `take: 1` بعد از مرتب‌سازی نزولی: در حالت عادی یک توکن باز وجود دارد،
 * ولی اگر به‌دلیلی دو تای همزمان باز مانده باشند، فقط جدیدترین بررسی می‌شود.
 */
export async function findActiveTokenForUser(
    prisma: PasswordResetClient,
    userId: number,
): Promise<ActiveResetTokenRow | null> {
    const row = await prisma.passwordResetToken.findFirst({
        where: { userId, usedAt: null, invalidatedAt: null },
        orderBy: { createdAt: "desc" },
    })
    return (row as ActiveResetTokenRow | null) ?? null
}

/**
 * consumeTokenForLogin — آیا این رشته همان رمز موقتِ فعال کاربر است؟
 *
 * این تابع **سمت لاگین** است (پیش از ورود)، پس نباید توکن را مصرف کند؛ فقط
 * احراز می‌کند و شمارندهٔ تلاش را یکی زیاد می‌کند. مصرف واقعی در
 * `consumeTokenAndSetPassword` (سمت تعیین رمز جدید) انجام می‌شود.
 *
 * همهٔ حالت‌های رد یک پاسخ یکسان می‌دهند (`PasswordResetRejectedError`) تا
 * مسیر لاگین قابلیت enumeration نداشته باشد: منقضی / مصرف‌شده / باطل‌شده /
 * تمام‌شدن تلاش‌ها / هش نادرست — همه یکی.
 */
export async function consumeTokenForLogin(
    prisma: PasswordResetClient,
    input: { userId: number; candidate: string; now?: Date },
): Promise<{ ok: true; tokenId: string } | { ok: false }> {
    const now = input.now ?? new Date()
    const row = await findActiveTokenForUser(prisma, input.userId)

    if (!row) return { ok: false }
    if (row.usedAt !== null || row.invalidatedAt !== null) return { ok: false }
    if (row.expiresAt.getTime() <= now.getTime()) return { ok: false }

    const matches = await bcrypt.compare(input.candidate, row.tokenHash)

    // شمارندهٔ تلاش در هر دو حالت بالا می‌رود (درست و نادرست): مهاجم با حدس‌های
    // اشتباه هم به سقف می‌رسد، پس سقف قابل دور زدن نیست.
    await incrementAttempts(prisma, row.id)

    if (!matches) return { ok: false }

    // سقف تلاش: `row.attempts` تعداد تلاش‌های *قبلاً مصرف‌شده* است. پس وقتی به
    // `maxAttempts` رسیده باشیم، یعنی هر ۵ تلاش مجاز رفته و ششمین رد است.
    // (نوشتن `row.attempts + 1 >= ...` یک off-by-one می‌داد و فقط ۴ تلاش واقعی
    // اجازه می‌داد، در حالی که قرارداد «۵ تلاش» است.)
    if (row.attempts >= row.maxAttempts) return { ok: false }

    return { ok: true, tokenId: row.id }
}

/** یکی زیاد کردن `attempts` — فقط شمارنده است، تصمیم‌گیری در caller. */
async function incrementAttempts(prisma: PasswordResetClient, tokenId: string): Promise<void> {
    try {
        await prisma.passwordResetToken.updateMany({
            where: { id: tokenId },
            data: { attempts: { increment: 1 } },
        })
    } catch {
        // fail-open روی شمارنده: نباید یک خطای ثبت تلاش، ورودِ درست را باطل کند.
    }
}

/**
 * consumeTokenAndSetPassword — رمز موقت را **مصرف** می‌کند و رمز دائمی می‌نویسد.
 *
 * هر دو در یک تراکنش، به‌ترتیب:
 *   1) `DELETE ... WHERE id = ?` → اگر `count === 0` توکن مصرف/باطل شده (race یا replay).
 *   2) `UPDATE User SET password = <hash>, mustChangePassword = false`.
 *
 * چرا DELETE و نه `usedAt`؟ چون `count === 0` همان‌طور که در `OtpCode` استفاده
 * شده (`verify-otp/route.ts`) تضمین می‌کند دو درخواست همزمان دقیقاً یکی برنده شود —
 * بدون نیاز به قفل یا سطح جدول.
 *
 * `@param prisma` باید یک `$transaction` را از قبل دریافت کرده باشد (tx).
 */
export async function consumeTokenAndSetPassword(
    tx: PasswordResetClient,
    input: { userId: number; tokenId: string; newPassword: string },
): Promise<void> {
    const deleted = await tx.passwordResetToken.deleteMany({
        where: { id: input.tokenId, userId: input.userId },
    })
    if (deleted.count === 0) {
        // توکن در همان لحظه مصرف شده — replay یا race. خطای عمومی، بدون جزئیات.
        throw new PasswordResetRejectedError()
    }

    const hashed = await bcrypt.hash(input.newPassword, BCRYPT_COST)
    await tx.user.update({
        where: { id: input.userId },
        data: { password: hashed, mustChangePassword: false },
    })
}

/**
 * خطای واحد برای همهٔ حالت‌های رد توکن.
 *
 * عمداً یک کلاس برای «نامعتبر/منقضی/مصرف‌شده/بی‌اثر»؛ چون endpoint تعیین رمز جدید
 * فقط کاربری را می‌رساند که خودش همین حالا با رمز موقت لاگین کرده، پس تفکیک این
 * حالت‌ها هیچ اطلاعاتی به کسی نمی‌دهد ولی سطح حمله را بزرگ می‌کند.
 */
export class PasswordResetRejectedError extends ServiceError {
    constructor() {
        super(
            400,
            "PASSWORD_RESET_INVALID",
            "این درخواست معتبر نیست؛ دوباره رمز موقت بگیرید",
            undefined,
            "BUSINESS_RULE",
            "INFO",
        )
    }
}

/** پاک‌سازی توکن‌های منقضی (به‌روزرسانی دوره‌ای / cron). */
export async function purgeExpiredTokens(
    prisma: PasswordResetClient,
    now: Date = new Date(),
): Promise<number> {
    const result = await prisma.passwordResetToken.deleteMany({
        where: { expiresAt: { lt: now } },
    })
    return result.count
}

/** راحتی برای route: کلاینت واقعی Prisma به‌عنوان کلاینت محدود سرویس. */
export function prismaAsResetClient(): PasswordResetClient {
    return getPrisma() as unknown as PasswordResetClient
}
