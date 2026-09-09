import { z } from "zod"

const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/

export const rolloverSchema = z.object({
    taskIds: z.array(z.number().int().positive()).min(1, "حداقل یک تسک انتخاب کنید"),
})

export const dayPlanSchema = z.object({
    dayKey: z.string().regex(dayKeyPattern, "فرمت روز نامعتبر است"),
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
