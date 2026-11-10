import { NextResponse } from "next/server"
import jwt from "jsonwebtoken"
import { deriveSessionVersion } from "./sessionVersion"

// ساخت session مشترک بین login و register (G-14):
// JWT با payload {id, email} + کوکی httpOnly «token» با maxAge 7 روز

/** عمر عادی نشست — ۷ روز. */
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

/**
 * `mustChangePassword` و `resetTokenId` هم در JWT حمل می‌شوند ولی **مرجع حقیقت
 * نیستند**:
 *
 * • `mustChangePassword` — enforcement از DB می‌خواند (`getCurrentUser` →
 *   `requireVerifiedUser`). دلیل حمل‌کردن: در لحظهٔ صدور سشن قطعاً درست است.
 *
 * • `resetTokenId` — شناسهٔ همان توکنِ بازیابی که این سشن را مجاز کرده. برخلاف
 *   پرچم بالا، این یک claim **واقعاً مصرف می‌شود**: `set-new-password` فقط همین
 *   توکن را می‌پذیرد. بدون آن، هر نشستی که برای کاربر وجود داشت (حتی نشستی که با
 *   رمز دائمی ساخته شده) می‌توانست با داشتن یک توکن باز، رمز را عوض کند.
 *
 * چرا `maxAgeSeconds` اختیاری است؟ سشنِ «رمز موقت» یک سشن عادی نیست: یک grant
 * محدود است که فقط تا انقضای توکن معتبر می‌ماند (پیش‌فرض ۱۵ دقیقه). سقف‌زدن
 * عمرِ کوکی *و* عمرِ JWT به همین بازه، پنجرهٔ سوءاستفاده را دقیقاً هم‌اندازهٔ
 * عمرِ توکن نگه می‌دارد، نه ۷ روزه.
 */
export function createSession(
    user: {
        id: number
        email: string
        mustChangePassword?: boolean
        resetTokenId?: string | null
        /** هش رمز فعلی — تا claim `sv` از آن مشتق شود. */
        password?: string
    },
    response: NextResponse,
    options: { maxAgeSeconds?: number; passwordHash?: string } = {},
) {
    const secret = process.env.JWT_SECRET

    if (!secret) {
        throw new Error("JWT_SECRET missing")
    }

    const maxAgeSeconds = Math.max(
        1,
        Math.min(options.maxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS, DEFAULT_SESSION_MAX_AGE_SECONDS),
    )

    /*
     * `sv` = نسخهٔ نشست. با تغییر رمز، هش عوض می‌شود و همهٔ توکن‌های قبلی در
     * `getCurrentUser` رد می‌شوند. اگر هش در دسترس نباشد (مثلاً مسیری که فقط
     * id/email دارد) مقدار `null` می‌رود؛ `getCurrentUser` آن را «توکن legacy»
     * می‌داند و می‌پذیرد — تا هیچ مسیر فعلی نشکند.
     */
    const passwordHash = options.passwordHash ?? user.password
    const sessionVersion =
        typeof passwordHash === "string" && passwordHash.length > 0
            ? deriveSessionVersion(passwordHash, secret)
            : null

    const token = jwt.sign(
        {
            id: user.id,
            email: user.email,
            mustChangePassword: user.mustChangePassword === true,
            // `null` نه `undefined`: کلید همیشه در payload هست تا شکل JWT
            // بین نشست‌های عادی و محدود یکنواخت بماند.
            resetTokenId: user.resetTokenId ?? null,
            sv: sessionVersion,
        },
        secret,
        { expiresIn: maxAgeSeconds },
    )

    response.cookies.set("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: maxAgeSeconds,
        path: "/",
    })

    return response
}
