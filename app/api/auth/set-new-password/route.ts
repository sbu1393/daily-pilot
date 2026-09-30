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
 *   ۱) نشست معتبر — که فقط پس از تأیید OTP ساخته شده است.
 *   ۲) توکن فعالِ متعلق به **همین** کاربر که هنوز مصرف نشده و منقضی نشده.
 *   ۳) تراکنش واحد — حذف توکن و نوشتن رمز جدید با هم، یا هیچ‌کدام.
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

        if (isRateLimited(`setpw:user:${user.id}`, USER_MAX_ATTEMPTS, WINDOW_MS)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تلاش‌های زیادی انجام شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

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

            // «فعال‌ترین» توکنِ کاربر. اگر چندتا باز مانده باشد (حالت غیرعادی)،
            // فقط جدیدترین بررسی می‌شود.
            const row = await client.passwordResetToken.findFirst({
                where: { userId: user.id, usedAt: null, invalidatedAt: null },
                orderBy: { createdAt: "desc" },
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
                tokenId: row.id,
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
