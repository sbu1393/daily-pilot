import { z } from "zod"

import { TASK_CATEGORY_KEYS } from "@/app/lib/categories"

// خروجی ساختاریافته هوش مصنوعی برای هر تسک
//
// `category` از همان واژگان canonical دسته‌بندی تسک استفاده می‌کند (یک منبع حقیقت
// برای UI و backend و AI). این فیلد فقط **پیشنهاد تحلیل** است: در `reanalyzeTask`
// هرگز دستهٔ انتخابی کاربر را بازنویسی نمی‌کند (`task.category ?? analysis.category`).
//
// توجه: فوریت دسته‌بندی نیست — آن در `priority`/`score` است.
export const aiAnalysisSchema = z.object({
    priority: z.enum(["HIGH", "MEDIUM", "LOW"]),
    score: z.coerce.number().int().min(0).max(100),        // اهمیت + فوریت (۰ تا ۱۰۰)
    estimatedMinutes: z.coerce.number().int().min(5).max(480), // تخمین زمان به دقیقه
    reason: z.string().min(1).max(300),                     // چرایی (فارسی)
    category: z.enum(TASK_CATEGORY_KEYS),                   // واژگان canonical — بدون Urgent
})

export type AiAnalysis = z.infer<typeof aiAnalysisSchema>
