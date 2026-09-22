import { z } from "zod"

// ADR-07 — اعتبارسنجی ورودی Web Push.
// فقط داده‌ی لازم برای ثبت subscription؛ هیچ فیلد userId از client پذیرفته نمی‌شود
// (ownership از session سمت سرور می‌آید).
//
// endpoint یک URL طولانی Push است (https). اعتبارسنجی با URL واقعی + پروتکل، چون
// تاریخچه‌ی malformed باید 400 بدهد نه 500.

const endpointField = z
    .string()
    .trim()
    .min(1, "آدرس اشتراک الزامی است")
    .max(2048, "آدرس اشتراک خیلی طولانی است")
    .refine((s) => {
        try {
            const url = new URL(s)
            return url.protocol === "https:" || url.protocol === "http:"
        } catch {
            return false
        }
    }, "آدرس اشتراک نامعتبر است")

const keysField = z.object({
    p256dh: z.string().trim().min(1, "کلید p256dh الزامی است").max(512, "کلید p256dh نامعتبر است"),
    auth: z.string().trim().min(1, "کلید auth الزامی است").max(512, "کلید auth نامعتبر است"),
})

export const pushSubscribeSchema = z.object({
    endpoint: endpointField,
    keys: keysField,
})

export const pushUnsubscribeSchema = z.object({
    endpoint: endpointField,
})

export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>
export type PushUnsubscribeInput = z.infer<typeof pushUnsubscribeSchema>
