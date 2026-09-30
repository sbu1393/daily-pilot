import { NextRequest } from "next/server"

import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { isRateLimited } from "@/app/lib/rateLimit"
import { setNewPasswordSchema } from "@/app/schema/formSchema"
import {
    consumeTokenAndSetPassword,
    PasswordResetRejectedError,
    type PasswordResetClient,
} from "@/app/lib/services/passwordReset.service"
import {
    errorResponse,
    okMessageResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

const LOG_PREFIX = "[set-new-password]"

/** سقف تلاش — endpoint کاربرِ لاگین‌شده است، پس سقف روی خودِ کاربر کافی است. */
const USER_MAX_ATTEMPTS = 10
const WINDOW_MS = 15 * 60 * 1000

/**
 * POST /api/auth/set-new-password
 *
 * تنها endpointی که در وضعیت `mustChangePassword` **باید** کار کند — برای همین
 * عمداً `requireVerifiedUser` را صدا نمی‌زند (آن گارد دقیقاً همین وضعیت را
 * مسدود می‌کند) و فقط `getCurrentUser` می‌گیرد تا نشست معتبر را اثبات کند.
 *
 * امنیت از سه چیز می‌آید و هیچ‌کدام به ورودی کاربر تکیه ندارد:
 *   ۱) نشست معتبر که `resetTokenId` دارد — یعنی نشستی که **همین حالا با رمز موقت
 *      ساخته شده**. یک نشست عادی (حتی با نشست فعالِ دیگرِ همان کاربر) این claim
 *      را ندارد و همین‌جا رد می‌شود.
 *   ۲) توکنِ دقیقاً همان `resetTokenId` که هنوز مصرف نشده و منقضی نشده.
 *   ۳) تراکنش واحد — حذف توکن و نوشتن رمز جدید با هم، یا هیچ‌کدام.
 *
 * چرا `resetTokenId` و نه «آخرین توکن باز کاربر»؟ قبلاً همین endpoint فقط
 * `userId` را می‌دید و «جدیدترین توکن باز» را برمی‌داشت. نتیجه: **هر** نشستِ
 * معتبرِ کاربر (حتی نشستی که با رمز دائمی ساخته شده بود) می‌توانست به‌عنوان
 * درِ دور زدنِ `currentPassword` در `change-password` استفاده شود: کافی بود
 * کاربر برای ایمیل خودش یک forgot-password بزند تا یک توکن فعال داشته باشد.
 * با سنجاق‌کردن سشن به همان توکنی که آن را مجاز کرده، این در بسته می‌شود.
 *
 * نکتهٔ UX: کاربر **رمز موقت را دوباره وارد نمی‌کند**؛ به این دلیل schema عمداً
 * `currentPassword` ندارد (به `app/schema/formSchema.ts` مراجعه کنید).
 */
export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/auth/set-new-password", "auth")

    try {
        // فقط هویت — نه گاردِ عملیات. دلیل: کاربر باید بتواند از این وضعیت خارج شود.
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        // rate limit اول: ارزان است و باید قبل از هر کار دیگری بیاید.
        if (isRateLimited(`setpw:user:${user.id}`, USER_MAX_ATTEMPTS, WINDOW_MS)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تلاش‌های زیادی انجام شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        // grant باید متعلق به همین نشست باشد. نشست‌های عادی (از جمله نشستی که با
        // رمز دائمی ساخته شده) `resetTokenId` ندارند و همین‌جا رد می‌شوند.
        const resetTokenId = user.resetTokenId
        if (!resetTokenId) throw new PasswordResetRejectedError()

        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return validationErrorResponse(undefined, undefined, context.requestId)

        const parsed = setNewPasswordSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(
                parsed.error.flatten(),
                undefined,
                context.requestId,
            )
        }

        const { newPassword } = parsed.data

        const prisma = getPrisma()

        await prisma.$transaction(async (tx: unknown) => {
            const client = tx as PasswordResetClient

            // **همان** توکنی که این نشست را مجاز کرده — نه «آخرین توکن باز».
            // کاربر و توکن هر دو در `where` می‌آیند تا توکنِ کاربر دیگری
            // (که طریق دست‌کاری کوکی ممکن است در payload بیاید) پذیرفته نشود.
            const row = await client.passwordResetToken.findFirst({
                where: { id: resetTokenId, userId: user.id, usedAt: null, invalidatedAt: null },
                select: { id: true, expiresAt: true },
            })

            if (!row || row.expiresAt.getTime() <= Date.now()) {
                throw new PasswordResetRejectedError()
            }

            // حذف اتمیک + نوشتن رمز دائمی + صفر کردن فلگ، همه در یک تراکنش.
            // `deleteMany` با `count === 0` تضمین می‌کند دو درخواست همزمان دقیقاً
            // یکی برنده شود (race/replay) — بدون نیاز به قفل.
            await consumeTokenAndSetPassword(client, {
                userId: user.id,
                tokenId: resetTokenId,
                newPassword,
            })
        })

        console.log(`${LOG_PREFIX} permanent password set; forced-change cleared`, {
            requestId: context.requestId,
            userId: user.id,
        })

        return okMessageResponse("رمز عبور با موفقیت تغییر یافت ✅", 200, context.requestId)
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}
