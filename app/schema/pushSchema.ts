import { z } from "zod"

/*
 * یادآورها — اعتبارسنجی ورودی اشتراک Web Push
 * ---------------------------------------------------------------
 * بدنه دقیقاً همان `PushSubscription.toJSON()` استاندارد مرورگر است:
 *   { endpoint, expirationTime, keys: { p256dh, auth } }
 * `expirationTime` عمداً پذیرفته و نادیده گرفته می‌شود (مرورگر همیشه null می‌دهد).
 *
 * قواعد:
 *  - endpoint باید URL مطلق https باشد (تمام سرویس‌های Push روی https هستند و
 *    URLهای غیرhttps/رشته‌های دلخواه هرگز به provider فرستاده نمی‌شوند).
 *  - طول‌ها محدود شده‌اند تا یک کاربر نتواند ردیف‌های حجیم بسازد.
 *  - فیلد اضافی حذف می‌شود (zod ذاتی) — هیچ کلید ناشناسی به DB نمی‌رود.
 */

const MAX_ENDPOINT_LENGTH = 2048
const MAX_KEY_LENGTH = 255

function isHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === "https:"
    } catch {
        return false
    }
}

export const pushSubscribeSchema = z.object({
    endpoint: z
        .string()
        .trim()
        .min(1, "endpoint لازم است")
        .max(MAX_ENDPOINT_LENGTH, "endpoint خیلی طولانی است")
        .refine(isHttpsUrl, "endpoint باید یک URL معتبر https باشد"),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({
        p256dh: z.string().trim().min(1, "کلید p256dh لازم است").max(MAX_KEY_LENGTH),
        auth: z.string().trim().min(1, "کلید auth لازم است").max(MAX_KEY_LENGTH),
    }),
})

export const pushUnsubscribeSchema = z.object({
    endpoint: z
        .string()
        .trim()
        .min(1, "endpoint لازم است")
        .max(MAX_ENDPOINT_LENGTH, "endpoint خیلی طولانی است"),
})

export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>
export type PushUnsubscribeInput = z.infer<typeof pushUnsubscribeSchema>
