// Phase 1 (AI Daily Plan) — AI batch output schema
// -------------------------------------------------
// قرارداد ساختاریافتهٔ خروجی AI برای «ایجاد برنامه»: ورودی = مجموعهٔ کامل تسک‌های روز،
// خروجی = تخمین زمان/امتیاز/اولویتِ همهٔ تسک‌ها (recommended order به‌عنوان hint).
//
// قواعد:
// - همان bounds موجود در aiSchema.ts (estimate 5..480، score 0..100، priority سه‌مقداری).
// - taskId در دامنه عدد صحیح است (Int autoincrement)؛ پس هم عدد و هم رشتهٔ عددی پذیرفته و
//   coerce می‌شود. مقادیر غیرعددی/منفی/غیرصحیح رد می‌شوند.
// - cross-field checks (تکرار taskId/order، تکرار/همپوشانی unscheduled) در همین schema
//   اعمال می‌شوند تا خروجی نامعتبر هرگز از parse عبور نکند.
// - suitability برای parseAjJson pipeline: از همان extractJson (repair.ts) استفاده می‌شود.
//
// توجه: این schema هیچ تصمیمِ ظرفیتی نمی‌گیرد. ظرفیت/تخصیص فقط مسئولیت planner قطعی است.

import { z } from "zod"

import { extractJson } from "./repair"

/** اولویت تسک — همان دامنهٔ aiSchema / TaskPriority */
export const planPrioritySchema = z.enum(["HIGH", "MEDIUM", "LOW"])
export type PlanPriority = z.infer<typeof planPrioritySchema>

/** یک آیتم تحلیلی برای یک تسک مشخص */
export const aiPlanItemSchema = z.object({
    taskId: z.coerce.number().int().positive(),
    // همان محدودهٔ aiAnalysisSchema.estimatedMinutes
    estimatedMinutes: z.coerce.number().int().min(5).max(480),
    // همان محدودهٔ aiAnalysisSchema.score
    score: z.coerce.number().int().min(0).max(100),
    priority: planPrioritySchema,
    // ترتیب پیشنهادیِ AI — عدد صحیح مثبت؛ یکتا (چک پایین)
    order: z.coerce.number().int().positive(),
    reason: z.string().min(1).max(300).optional(),
})
export type AiPlanItem = z.infer<typeof aiPlanItemSchema>

/**
 * خروجی batch — هر تسک ورودی دقیقاً یک‌بار در items یا unscheduledTaskIds می‌آید
 * (این کامل‌بودن نسبت به ورودی، در planContract.validateBatchPlan بررسی می‌شود،
 * چون schema نمی‌داند ورودی چه taskIdهایی داشته است).
 */
export const aiBatchPlanSchema = z
    .object({
        items: z.array(aiPlanItemSchema).min(1),
        unscheduledTaskIds: z.array(z.coerce.number().int().positive()).optional(),
        summary: z.string().min(1).max(600).optional(),
    })
    // taskId یکتا
    .refine((value) => new Set(value.items.map((i) => i.taskId)).size === value.items.length, {
        message: "taskId تکراری در items",
        path: ["items"],
    })
    // order یکتا
    .refine((value) => new Set(value.items.map((i) => i.order)).size === value.items.length, {
        message: "order تکراری در items",
        path: ["items"],
    })
    // unscheduledTaskIds یکتا
    .refine(
        (value) =>
            new Set(value.unscheduledTaskIds ?? []).size === (value.unscheduledTaskIds ?? []).length,
        {
            message: "شناسهٔ تکراری در unscheduledTaskIds",
            path: ["unscheduledTaskIds"],
        },
    )
    // یک تسک نمی‌تواند هم planned و هم unscheduled باشد
    .refine(
        (value) => {
            const scheduled = new Set(value.items.map((i) => i.taskId))
            return (value.unscheduledTaskIds ?? []).every((id) => !scheduled.has(id))
        },
        {
            message: "یک تسک نمی‌تواند هم planned و هم unscheduled باشد",
            path: ["unscheduledTaskIds"],
        },
    )

export type AiBatchPlan = z.infer<typeof aiBatchPlanSchema>

/**
 * parseAiPlanJson — خروجی خام مدل → خروجی batch معتبر.
 * از همان extractJson (repair.ts) استفاده می‌کند تا markdown / متن اضافه / کامای اضافه تحمل شود؛
 * zod آخرین گارد است (strict + cross-field).
 */
export function parseAiPlanJson(raw: string): AiBatchPlan {
    return aiBatchPlanSchema.parse(JSON.parse(extractJson(raw)))
}
