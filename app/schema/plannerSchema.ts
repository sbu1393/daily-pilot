import { z } from "zod"
import { isValidCanonicalDayKey } from "@/app/lib/canonicalDay"
import { planPrioritySchema } from "@/app/lib/ai/planSchema"

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
        .min(1, "بودجه‌ی روز باید حداقل ۱ دقیقه باشد")
        .max(1440, "حداکثر ۲۴ ساعت"),
})
// Phase 2 — POST /api/planner/plan: فقط انتخاب روز.
// dayKey اختیاری است (پیش‌فرض «امروزِ» کاربر از timezone سرور)؛ مالکیت و ظرفیت سمت سرور resolve می‌شود.
// هیچ task/availableMinutes ای از Client پذیرفته نمی‌شود (نه تحمیل task، نه override ظرفیت).
export const planRequestSchema = z.object({
    dayKey: z.string().refine(isValidCanonicalDayKey, "فرمت روز نامعتبر است").optional(),
})

// Phase 3 — POST /api/planner/plan/apply: اعمال یک proposal گذرا روی وضعیت روز.
// -----------------------------------------------------------------------------
// قرارداد ورودی (§۳ فاز ۳): { dayKey, expectedPlanVersion, proposal }.
// proposal **untrusted** است (از client می‌آید) — حتی اگر قبلاً توسط /api/planner/plan ساخته شده،
// اینجا فقط یک ورودی خام تلقی می‌شود. schema فقط چک‌های ساختاری/درون‌proposal را انجام می‌دهد
// (دامنه‌ها، تکرار، هم‌پوشانی). چک‌های DBمحور (مالکیت task، روز، نسخه، حذف/اتمام بعد از Generate)
// در سرویس انجام می‌شوند و به‌صورت 409 PLAN_STALE برمی‌گردند (§۴/§۱۲).
//
// نکته: هیچ estimatedMinutes/score/priority ای «مستقیم» به allocation تبدیل نمی‌شود؛ این فیلدها فقط
// ورودی‌های وزن موتور قطعی‌اند (§۶).

const planProposalPlannedItemSchema = z.object({
    taskId: z.number().int().positive(),
    // همان bounds موتور/AI schema
    estimatedMinutes: z.number().int().min(5).max(480),
    suggestedMinutes: z.number().int().nonnegative(),
    // rank قطعی موتور — عدد صحیح مثبت و یکتا (چک پایین)
    order: z.number().int().positive(),
    aiOrder: z.number().int().positive().nullable(),
    // دلیل کوتاه AI — فقط informational. کلید اجباری ولی nullable (تا round-trip
    // بی‌ابهام بماند) و bounded با همان محدوده‌ی planSchema.
    // سرویس Apply آن را نمی‌خواند و در DB نمی‌نویسد (Task.reason دست‌نخورده می‌ماند).
    reason: z.string().min(1).max(300).nullable(),
    priority: planPrioritySchema.nullable(),
    score: z.number().int().min(0).max(100).nullable(),
    weight: z.number().nonnegative(),
    partial: z.boolean(),
})

const planProposalUnfittedItemSchema = z.object({
    taskId: z.number().int().positive(),
    estimatedMinutes: z.number().int().min(5).max(480),
    weight: z.number().nonnegative(),
    aiOrder: z.number().int().positive().nullable(),
    // همان semantics آیتم‌های planned: informational و bounded
    reason: z.string().min(1).max(300).nullable(),
    // Phase 4.2 — همان semantics/bounds آیتم‌های planned: بدون این دو، Apply نمی‌تواند
    // metadata تسک‌های unfitted را persist کند و state پس از rebalance با proposal فرق می‌کند.
    // (همان enum/range موجود — هیچ enum یا range جدیدی ساخته نشد.)
    priority: planPrioritySchema.nullable(),
    score: z.number().int().min(0).max(100).nullable(),
})

/**
 * قرارداد canonical پیشنهاد روز — **مشترک بین producer و consumer**.
 *
 * `buildPlanProposal` (تولیدکننده، فاز Generate) و `planApplyRequestSchema` (مصرف‌کننده،
 * فاز Apply) هر دو باید دقیقاً همین schema را اعمال کنند؛ وگرنه producer می‌تواند
 * proposal‌ای بسازد که consumer خودش آن را رد می‌کند (کلاسِ bugِ
 * «false VALIDATION_ERROR در Apply»).
 *
 * ── معناشناسی `aiUnscheduledTaskIds` (تصمیم معماری، ADR-08) ────────────────────
 * این فیلد یک **سیگنال advisory از AI** است: «AI خودش این تسک‌ها را جا نمی‌دانست».
 * `unfitted` حکم نهایی موتور قطعی است (authority) و `planned` هم حکم نهایی موتور است.
 *
 * چون AI مشاور است و scheduler نیست (ADR-08 / architecture §3.5)، موتور قطعی این تسک‌ها
 * را با مقادیر موجود خودشان وارد تخصیص می‌کند و **ممکن است تصمیم بگیرد جا دهدشان** —
 * حتی اگر AI گفته باشد جا نمی‌شوند. پس هم‌پوشانیِ `aiUnscheduledTaskIds` با `planned`
 * یا با `unfitted` یک **اختلاف نظر بین AI و Planner** است، نه proposal معیوب.
 *
 * بنابراین اینجا عمداً هیچ قیدِ «عدم هم‌پوشانی»‌ای وجود ندارد. فیلتر کردن این هم‌پوشانی
 * در producer هم خطاست: اطلاعاتِ «AI فکر می‌کرد جا نمی‌شود ولی Planner جا داد» را بی‌صدا
 * نابود می‌کند و AI را عملاً veto می‌کند — نقض مستقیمِ «AI advisory / engine authority».
 *
 * قیدهای ساختاریِ معتبر (یکتایی، bounds، عدم تکرار task/order، عدم planned∩unfitted) عمداً
 * حفظ شده‌اند؛ فقط invariantِ نادرستِ هم‌پوشانی حذف شده است.
 */
export const planProposalSchema = z
    .object({
        basis: z.object({
            dayKey: z.string(),
            planVersion: z.number().int().nonnegative(),
            rebalancedVersion: z.number().int().nonnegative().nullable(),
            availableMinutes: z.number().int().nonnegative(),
            taskCount: z.number().int().nonnegative(),
            state: z.literal("fresh"),
        }),
        planned: z.array(planProposalPlannedItemSchema),
        unfitted: z.array(planProposalUnfittedItemSchema),
        plannedMinutes: z.number().int().nonnegative(),
        remainingMinutes: z.number().int().nonnegative(),
        // شناسه‌های advisory — یکتا. هم‌پوشانی با planned/unfitted مجاز است
        // (اختلاف نظر AI و Planner؛ بالا را ببینید).
        aiUnscheduledTaskIds: z.array(z.number().int().positive()),
        source: z.enum(["1xai", "mock"]),
        summary: z.string().max(600).optional(),
    })
    // taskId یکتا در planned
    .refine((v) => new Set(v.planned.map((i) => i.taskId)).size === v.planned.length, {
        message: "taskId تکراری در planned",
        path: ["planned"],
    })
    // taskId یکتا در unfitted
    .refine((v) => new Set(v.unfitted.map((i) => i.taskId)).size === v.unfitted.length, {
        message: "taskId تکراری در unfitted",
        path: ["unfitted"],
    })
    // یک task نمی‌تواند هم planned و هم unfitted باشد
    .refine(
        (v) => {
            const planned = new Set(v.planned.map((i) => i.taskId))
            return v.unfitted.every((i) => !planned.has(i.taskId))
        },
        { message: "یک تسک نمی‌تواند هم planned و هم unfitted باشد", path: ["unfitted"] },
    )
    // order یکتا در planned
    .refine((v) => new Set(v.planned.map((i) => i.order)).size === v.planned.length, {
        message: "order تکراری در planned",
        path: ["planned"],
    })
    // aiUnscheduledTaskIds یکتا — قید ساختاریِ معتبر (تنها قید این فیلد)
    .refine((v) => new Set(v.aiUnscheduledTaskIds).size === v.aiUnscheduledTaskIds.length, {
        message: "شناسهٔ تکراری در aiUnscheduledTaskIds",
        path: ["aiUnscheduledTaskIds"],
    })

// بدنه‌ی request Apply — dayKey و proposal.basis.dayKey هر دو معتبر و **هم‌روز**،
// و expectedPlanVersion با basis.planVersion **هم‌ارز** (این‌ها پیش‌شرط تطابق‌اند؛
// عدم تطابق = state نامعتبر → سرویس 409 PLAN_STALE می‌دهد، نه 400).
// به همین دلیل در این schema «صرفاً معتبر بودن هر فیلد» را چک می‌کنیم.
export const planApplyRequestSchema = z.object({
    dayKey: z.string().refine(isValidCanonicalDayKey, "فرمت روز نامعتبر است"),
    expectedPlanVersion: z.number().int().nonnegative(),
    proposal: planProposalSchema,
})

export const reanalyzeTaskSchema = z.object({
    text: z
        .string()
        .trim()
        .min(3, "عنوان باید حداقل ۳ حرف باشد")
        .max(200, "عنوان خیلی طولانی است")
        .optional(), // اگه نیاد، همون متن فعلی تسک دوباره تحلیل میشه
})
