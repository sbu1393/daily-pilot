import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * نسخهٔ نشست (Session Version) بدون هیچ migration یا ستون جدید.
 *
 * چرا؟ برای «باطل شدن نشست‌های قبلی بعد از تغییر رمز» می‌توان یک ستون
 * `sessionVersion` به `User` اضافه کرد، ولی هر تغییر schema نیازمند migration در
 * production است. نسخهٔ فعلی این پروژه عمداً بدون migration منتشر می‌شود، پس:
 *
 *   `sv = base64url(HMAC-SHA256(JWT_SECRET, passwordHash))` (۲۲ کاراکتر)
 *
 * - ورودیِ راز، خودِ **هش رمز** است: با هر `changePassword` / `set-new-password`
 *   هش عوض می‌شود ⇒ `sv` عوض می‌شود.
 * - `JWT_SECRET` باعث می‌شود اگر روزی هش رمز لو رفت، مهاجم نتواند `sv` بسازد
 *   (HMAC یک‌طرفه است و کلید جدا دارد).
 * - ۲۲ کاراکتر ≈ ۱۳۲ بیت؛ برای شناسه‌ای که فقط باید «برابر/نابرابر» باشد کافی
 *   است و JWT را بی‌جهت بزرگ نمی‌کند.
 *
 * سازگاری عقب‌رو: توکن‌های قدیمی که claim `sv` ندارند «legacy» محسوب می‌شوند و
 * همچنان کار می‌کنند (تا کاربران فعلی با deploy یک‌جا بیرون نیفتند). همهٔ
 * توکن‌های تازه‌صادرشده `sv` دارند و حداکثر ۷ روز عمر می‌کنند، پس این پنجرهٔ
 * گذار خودبه‌خود بسته می‌شود.
 */

const SESSION_VERSION_LENGTH = 22

export function deriveSessionVersion(passwordHash: string, secret: string): string {
    return createHmac("sha256", secret)
        .update(passwordHash, "utf8")
        .digest("base64url")
        .slice(0, SESSION_VERSION_LENGTH)
}

/**
 * مقایسهٔ ثابت-زمان. اگر claim یا هش موجود نباشد/شکلی نباشد → ناسازگار.
 * `timingSafeEqual` فقط روی بافرهای هم‌طول کار می‌کند، پس طول اول بررسی می‌شود
 * (خودِ طول راز نیست و نشت اطلاعات محسوب نمی‌شود).
 */
export function isSessionVersionValid(
    claimed: unknown,
    passwordHash: string | null | undefined,
    secret: string,
): boolean {
    if (typeof claimed !== "string" || claimed.length === 0) return false
    if (typeof passwordHash !== "string" || passwordHash.length === 0) return false

    const expected = deriveSessionVersion(passwordHash, secret)
    const claimedBuffer = Buffer.from(claimed, "utf8")
    const expectedBuffer = Buffer.from(expected, "utf8")

    return (
        claimedBuffer.length === expectedBuffer.length &&
        timingSafeEqual(claimedBuffer, expectedBuffer)
    )
}
