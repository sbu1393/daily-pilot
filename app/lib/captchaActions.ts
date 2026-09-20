/**
 * نام actionهای کپچا (Cloudflare Turnstile).
 *
 * چرا یک فایل جدا؟
 * کلاینت (ویجت Turnstile) action را روی چالش ثبت می‌کند و سرور همان مقدار را
 * از پاسخ Cloudflare انتظار دارد. اگر این دو از هم جدا شوند (دو رشته‌ی مستقل)،
 * با اولین تغییر نام یکی از آن‌ها همه‌ی درخواست‌ها fail-closed می‌شوند.
 *
 * نکته‌ی امنیتی: سرور هرگز action را از بدنه‌ی درخواست (ورودی کلاینت) نمی‌خواند؛
 * همیشه از همین ثابت‌ها استفاده می‌کند.
 */
export const CAPTCHA_ACTIONS = {
    register: "register",
    login: "login",
    sendOtp: "send_otp",
    verifyOtp: "verify_otp",
} as const

export type CaptchaAction = (typeof CAPTCHA_ACTIONS)[keyof typeof CAPTCHA_ACTIONS]
