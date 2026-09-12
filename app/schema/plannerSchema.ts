import { z } from "zod"
import { isValidCanonicalDayKey } from "@/app/lib/canonicalDay"

export const rolloverSchema = z.object({
    taskIds: z.array(z.number().int().positive()).min(1, "حداقل یک تسک انتخاب کنید"),
    // A1 Phase 4 — اختیاری (additive، بدون شکستن قرارداد ADR-006 §4):
    // اگر Client نسخه‌ی blueprint را بفرستد، rollover فقط روی همان نسخه اجرا می‌شود (§6.3.2).
    planVersion: z.number().int().nonnegative().optional(),
})

export const dayPlanSchema = z.object({
    // M10: قالب + تقویم واقعی — «2026-13-99» یا «2026-02-30» نباید ذخیره شوند
    dayKey: z.string().refine(isValidCanonicalDayKey, "فرمت روز نامعتبر است"),
    availableMinutes: z.coerce
        .number()
        .int()
        .min(0, "نمی‌تواند منفی باشد")
        .max(1440, "حداکثر ۲۴ ساعت"),
})
export const reanalyzeTaskSchema = z.object({
    text: z
        .string()
        .trim()
        .min(3, "عنوان باید حداقل ۳ حرف باشد")
        .max(200, "عنوان خیلی طولانی است")
        .optional(), // اگه نیاد، همون متن فعلی تسک دوباره تحلیل میشه
})
