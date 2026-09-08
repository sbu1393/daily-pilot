import { z } from "zod"

const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/

export const createTaskSchema = z.object({
    text: z
        .string()
        .trim()
        .min(3, "عنوان باید حداقل ۳ حرف باشد")
        .max(200, "عنوان خیلی طولانی است"),
    dayKey: z.string().regex(dayKeyPattern, "فرمت روز نامعتبر است"),
})

export const completeTaskSchema = z.object({
    durationMinutes: z.coerce
        .number()
        .int("مدت باید عدد صحیح باشد")
        .min(1, "مدت باید حداقل ۱ دقیقه باشد")
        .max(600, "مدت نمی‌تواند بیشتر از ۱۰ ساعت باشد"),
})

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

// A1 — ویرایش تسک: Content (text) vs Planning-only (dayKey) + فراداده‌ی کاربر (category/priority)
export const updateTaskSchema = z
    .object({
        text: z
            .string()
            .trim()
            .min(3, "عنوان باید حداقل ۳ حرف باشد")
            .max(200, "عنوان خیلی طولانی است")
            .optional(),
        dayKey: z.string().regex(dayKeyPattern, "فرمت روز نامعتبر است").optional(),
        category: z
            .string()
            .trim()
            .min(1, "دسته‌بندی خالی است")
            .max(30, "دسته‌بندی حداکثر ۳۰ کاراکتر است")
            .nullable()
            .optional(),
        priority: z.enum(["HIGH", "MEDIUM", "LOW"]).nullable().optional(),
    })
    .refine(
        (d) =>
            d.text !== undefined ||
            d.dayKey !== undefined ||
            d.category !== undefined ||
            d.priority !== undefined,
        { message: "هیچ تغییری ارسال نشده است" },
    )
