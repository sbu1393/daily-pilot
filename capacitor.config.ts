import type { CapacitorConfig } from "@capacitor/cli"

/**
 * Capacitor PoC configuration — shell-only / remote-URL mode.
 * ---------------------------------------------------------
 * این پروژه یک Next.js سرور-محور (SSR + 51 API route) است و static export نمی‌شود.
 * پس PoC عمداً از `server.url` استفاده می‌کند: WebView همان سایت production را
 * باز می‌کند و SSR/API/Prisma/Neon/Auth دست‌نخورده باقی می‌مانند.
 *
 * قواعد:
 * - هیچ URL یا secret در این فایل hardcode نشده است.
 * - آدرس از متغیر محیطی `CAPACITOR_SERVER_URL` خوانده می‌شود (زمان اجرای CLI).
 * - اگر تنظیم نشده باشد، build عمداً متوقف نمی‌شود ولی مقدار placeholder امن دارد
 *   تا رفتار تصادفی نداشته باشیم؛ مقدار نهایی را قبل از تست گوشی باید ست کنی.
 *
 * مثال (فقط برای اجرای دستی، در env ست کن — نه داخل این فایل):
 *   CAPACITOR_SERVER_URL="https://<your-production-domain>" npx cap sync android
 */

/** آدرس سایت production — از env، بدون hardcode. */
const serverUrl = process.env.CAPACITOR_SERVER_URL ?? "https://example.invalid"

const config: CapacitorConfig = {
    appId: "ir.roozsaz.app", // موقت — قبل از انتشار نهایی باید قطعی شود
    appName: "روزساز",
    // PoC از asset باندل‌شده استفاده نمی‌کند؛ وب‌دیر صرفاً برای سازگاری CLI است.
    webDir: "public",
    server: {
        url: serverUrl,
        cleartext: false, // فقط HTTPS؛ هیچ ترافیک بدون TLS
    },
    android: {
        // PoC: فقط مجوز اینترنت؛ جزئیات مجوزها در android/ پس از cap add بررسی می‌شود.
        allowMixedContent: false,
    },
}

export default config
