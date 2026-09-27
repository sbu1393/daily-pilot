/*
 * تریگر زمان‌بندی‌شده — پیکربندی
 * ---------------------------------------------------------------
 * تنها متغیر لازم: `CRON_SECRET` (رشته‌ی تصادفی بلند). Vercel Cron وقتی این
 * متغیر در پروژه تعریف شده باشد، خودش هدر
 * `Authorization: Bearer <CRON_SECRET>` را به مسیر cron می‌فرستد.
 *
 * اگر تنظیم نشده باشد، مسیر cron **fail-closed** است (503) — چون آن مسیر
 * نشستی ندارد و بدون راز، فراخوانی آن یعنی ارسال Push برای همه‌ی کاربران.
 */

export const CRON_ENV = {
    secret: "CRON_SECRET",
    /** هدری که Vercel به درخواست‌های cron اضافه می‌کند (اطلاعاتی، نه امنیتی) */
    vercelHeader: "x-vercel-cron",
} as const

export type CronEnvLike = Record<string, string | undefined>

export function readCronSecret(env: CronEnvLike = process.env): string | null {
    const secret = (env[CRON_ENV.secret] ?? "").trim()
    return secret === "" ? null : secret
}

export function isCronConfigured(env: CronEnvLike = process.env): boolean {
    return readCronSecret(env) !== null
}
