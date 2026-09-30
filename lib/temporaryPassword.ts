import { randomInt } from "crypto"

/**
 * تولید رمز عبور موقت — رمز موقت «رمز عبور» است، پس باید همان قدرت آماریِ رمز
 * عبور خوب را داشته باشد، نه صرفاً یک کد کوتاه قابل حدس.
 *
 * چرا این‌قدر مشخصات سخت‌گیرانه است:
 * - **۷۲ بیت آنتروپی**: ۱۲ کاراکتر از ۶۲ نماد (۶۲^۱۲ ≈ ۳.۲×۱۰²¹). یک OTP ده‌رقمی
 *   فقط ~۳۳ بیت دارد و در برابر حملهٔ آنلاین قابل حدس است؛ رمز موقت چون روی مسیر
 *   لاگین می‌نشیند، باید از OTP قوی‌تر باشد نه ضعیف‌تر.
 * - **نویسه‌های مبهم حذف شده‌اند** (`0/O`, `1/l/I`): کاربر این کد را از ایمیل با
 *   چشم می‌خواند و کپی می‌کند؛ هر ابهام یعنی تلاش مجدد و سوختن rate limit.
 * - **حرکت یکنواخت**: `randomInt` از crypto (نه `Math.random`).
 */

/** الفبای بدون نویسهٔ مبهم: حذف 0/O و 1/l/I و 5/S و 2/Z و 8/B می‌شود تا خطای تایپ کم شود. */
const ALPHABET = "2345679ACDEFGHJKMNPQRTVWXYabcdefghijkmnpqrstuvwxyz" // 54 نماد

/** نویسه‌های سمبول — تضمین می‌کنند رمز موقت به سقف سخت‌گیری‌های رایج نمی‌خورد. */
const SYMBOLS = "!@#$%^&*?"

/** طول رمز موقت. ۱۲ کاراکتر از ALPHABET ≈ ۶۹ بیت + تضمین یک sym. */
export const TEMPORARY_PASSWORD_LENGTH = 12

/** تعداد نویسه‌های سمبول تضمین‌شده — تا strength-checkerهای سمت کاربر آن را رد نکنند. */
const SYMBOL_COUNT = 2

/**
 * generateTemporaryPassword — یک رمز موقت تصادفیِ امن برمی‌گرداند.
 *
 * الگوریتم (rejection-free و بدون بایاس): ابتدا دو جایگاه تصادفی برای sym انتخاب
 * می‌شود، بقیه از ALPHABET پر می‌شود، و در پایان دو sym روی همان جایگاه‌ها
 * نوشته می‌شوند. جایگاه‌ها یکتا هستند (با `Set` یکسان‌سازی شده) تا هر دو sym
 * روی یک کاراکتر نیفتند و طول ثابت بماند.
 *
 * Pure و بدون I/O — قابل تست مستقیم.
 */
export function generateTemporaryPassword(): string {
    const positions = new Set<number>()
    while (positions.size < SYMBOL_COUNT) {
        positions.add(randomInt(TEMPORARY_PASSWORD_LENGTH))
    }

    const chars: string[] = []
    for (let i = 0; i < TEMPORARY_PASSWORD_LENGTH; i++) {
        chars.push(ALPHABET[randomInt(ALPHABET.length)])
    }
    for (const position of positions) {
        chars[position] = SYMBOLS[randomInt(SYMBOLS.length)]
    }

    return chars.join("")
}

/** آیا رشته ساختار رمز موقت معتبر دارد؟ (guard سمت ورودی، نه جایگزین هش) */
export function isTemporaryPasswordShape(value: string): boolean {
    return value.length === TEMPORARY_PASSWORD_LENGTH
}
