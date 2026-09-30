import { getCurrentUser } from "./getCurrentUser"
import { PasswordChangeRequiredError, ServiceError } from "@/app/lib/services/errors"

/**
 * گارد مرکزیِ «رمز عبور موقت» — **تنها** نقطهٔ enforcement در کل اپ.
 *
 * چرا گارد جدا و نه یک `if` داخل `getCurrentUser`؟
 * `getCurrentUser()` را صفحه‌های عمومی (`/`, `/about`, `/faq`, `/privacy`) هم صدا
 * می‌زنند تا فقط دکمهٔ «ورود/داشبورد» را رندر کنند. اگر enforcement داخل خودِ
 * `getCurrentUser` بود، آن صفحه‌ها برای کاربری که رمز موقت دارد ۵۰۳ می‌شدند.
 * پس:
 *   • `getCurrentUser()` = **هویت** (resolve). تغییر رفتار نکرد.
 *   • `requireVerifiedUser()` = **هویت + اجازهٔ عملیات**.
 *
 * قرارداد (دقیقاً هم‌راستا با `requireAdmin`):
 *   نشست ندارد                     → 401 UNAUTHORIZED
 *   نشست دارد، mustChangePassword   → 403 PASSWORD_CHANGE_REQUIRED
 *   نشست دارد، وضعیت عادی          → user برمی‌گردد
 *
 * چرا UI کافی نیست: مودالِ `/auth/set-new-password` را می‌توان با devtools بست یا
 * با فراخوانی مستقیم `/api/tasks` کاملاً دور زد. این گارد همان لایه‌ای است که آن
 * دور زدن را می‌بندد.
 *
 * منبع حقیقت: `getCurrentUser` این پرچم را از **DB** می‌خواند (نه از JWT)، پس
 * حتی با دست‌کاری کوکی هم نمی‌توان enforcement را دور زد. JWT فقط می‌تواند پرچم را
 * حمل کند برای کاهش یک query، اما هیچ‌وقت مرجع تصمیم نیست.
 *
 * استثناها: endpointهای تعیین رمز جدید و تغییر رمز، خودشان گارد را صدا نمی‌زنند
 * (چون کاربر باید بتواند از این وضعیت *خروج* کند).
 */
export async function requireVerifiedUser() {
    const user = await getCurrentUser()

    if (!user) {
        throw new ServiceError(401, "UNAUTHORIZED", "Unauthorized")
    }

    // فقط DB-backed flag؛ هیچ منبع دیگری (JWT/کلاینت) معتبر نیست.
    if (user.mustChangePassword) {
        throw new PasswordChangeRequiredError()
    }

    return user
}

/** فقط برای تست: نام خطای ۴۰۳ تا تست‌ها رشتهٔ سخت نگه ندارند. */
export const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED"
