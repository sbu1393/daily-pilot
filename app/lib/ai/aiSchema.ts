import { z } from "zod"

// خروجی ساختاریافته هوش مصنوعی برای هر تسک
export const aiAnalysisSchema = z.object({
    priority: z.enum(["HIGH", "MEDIUM", "LOW"]),
    score: z.coerce.number().int().min(0).max(100),        // اهمیت + فوریت (۰ تا ۱۰۰)
    estimatedMinutes: z.coerce.number().int().min(5).max(480), // تخمین زمان به دقیقه
    reason: z.string().min(1).max(300),                     // چرایی (فارسی)
    category: z.string().min(1).max(30),                    // Work | Personal | Urgent | Health
})

export type AiAnalysis = z.infer<typeof aiAnalysisSchema>
