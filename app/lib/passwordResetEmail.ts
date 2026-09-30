// ایمیل رمز عبور موقت — subject و HTML، هر دو pure و بدون I/O.
//
// چرا فایل جدا و نه داخل route؟
// فایل‌های `app/api/**/route.ts` در App Router فقط اجازهٔ export کردن متدهای
// HTTP و چند فیلد config را می‌دهند؛ هر export دیگری build را می‌شکند. ضمناً
// جدا بودنشان یعنی متن ایمیل مستقل و بدون mock تست می‌شود.
//
// نکتهٔ امنیتی: این تنها جایی است که **plaintext** رمز موقت زندگی می‌کند (در
// حافظهٔ فراخوانی و همین رشته). نه در DB ذخیره می‌شود و نه در log.

import { PASSWORD_RESET_TTL_MS } from "@/app/lib/services/passwordReset.service"

/** طول عمر به دقیقه — برای متن ایمیل، از همان ثابت سرویس مشتق می‌شود. */
export const PASSWORD_RESET_TTL_MINUTES = PASSWORD_RESET_TTL_MS / 60_000

/** موضوع ایمیل — خالص، بدون هیچ دادهٔ کاربری. */
export function forgotPasswordEmailSubject(): string {
    return "رمز عبور موقت DailyPilot"
}

/**
 * بدنهٔ HTML ایمیل.
 *
 * دو نکتهٔ تجربهٔ کاربری که عمداً رعایت شده:
 * - رمز در `<strong>` با فاصلهٔ حروف بیشتر تا خواندنش از ایمیل راحت باشد.
 * - صریحاً گفته می‌شود که اگر درخواست از سمت کاربر نبوده، رمز فعلی تغییری
 *   نکرده — تا نگرانی ایجاد نشود و کاربر به اشتباه همه‌چیز را رها کند.
 */
export function forgotPasswordEmailHtml(
    temporaryPassword: string,
    minutes: number = PASSWORD_RESET_TTL_MINUTES,
): string {
    return (
        `<p>برای حساب کاربری شما یک <strong>رمز عبور موقت</strong> ساخته شد.</p>` +
        `<p>رمز موقت: <strong style="font-size:18px;letter-spacing:1px">${temporaryPassword}</strong></p>` +
        `<p>رمز موقت فقط از حروف انگلیسی (بزرگ و کوچک) و ارقام ساخته شده است؛ ` +
        `به بزرگی و کوچکی حروف و به ترتیب کاراکترها دقت کنید.</p>` +
        `<p>این رمز تا ${minutes} دقیقه معتبر است و فقط یک‌بار قابل استفاده است. ` +
        `پس از ورود، بلافاصله از شما خواسته می‌شود رمز عبور دائمی جدیدی تعیین کنید.</p>` +
        `<p>اگر شما این درخواست را نداده‌اید، این پیام را نادیده بگیرید؛ ` +
        `رمز عبور فعلی شما همچنان بدون تغییر باقی می‌ماند.</p>`
    )
}
