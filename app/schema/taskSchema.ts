import { canonicalKeyToLocalMidnight } from "@/app/lib/canonicalDay"
import {
    CATEGORY_ICON_WITHOUT_CATEGORY_MESSAGE,
    CATEGORY_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_ICON_INVALID_MESSAGE,
    CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_ICONS,
    CUSTOM_CATEGORY_LABEL_MESSAGE,
    CUSTOM_CATEGORY_MARKUP_MESSAGE,
    CUSTOM_CATEGORY_MIN_LENGTH,
    CUSTOM_CATEGORY_MAX_LENGTH,
    CUSTOM_CATEGORY_RESERVED_MESSAGE,
    PRESET_ICON_FORBIDDEN_MESSAGE,
    classifyCategory,
} from "@/app/lib/categories"
import { z } from "zod"

// C1 — Task CRUD validation (Phase C1: Task CRUD Foundation)
// قرارداد §6.2.2.1: dayKey هرگز از Client پذیرفته نمی‌شود — سمت سرور از
// scheduledDate + user.timezone محاسبه می‌شود. اینجا فقط scheduledDate (DateTime)
// و فیلدهای مستقیم Task وجود دارند.

// تاریخ/زمان مطلق: ISO 8601 (با offset) یا تاریخ روز "YYYY-MM-DD" یا timestamp عددی → Date معتبر
// null/undefined/فرمت‌های غیراستاندارد (مثل "2026-1-1")/تاریخ‌های تقویمی نامعتبر → خطای اعتبارسنجی
const dateOnlyRe = /^(\d{4})-(\d{2})-(\d{2})$/

const dateOnlyString = z.string().refine((s) => {
    const m = dateOnlyRe.exec(s)
    if (!m) return false
    const year = Number(m[1])
    const month = Number(m[2])
    const day = Number(m[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return false
    // round-trip: تاریخ‌هایی مثل 2026-02-30 نباید بی‌صدا نرمال شوند
    const d = new Date(Date.UTC(year, month - 1, day))
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}, "تاریخ نامعتبر است")

function makeScheduledDateField(timezone: string) {
    return z
        .union([
            dateOnlyString,
            z.string().datetime({ offset: true, message: "تاریخ نامعتبر است" }),
            z.number(),
        ])
        .transform((v) => typeof v === "string" && dateOnlyRe.test(v)
            ? canonicalKeyToLocalMidnight(v, timezone)
            : new Date(v))
        .refine((d) => !Number.isNaN(d.getTime()), "تاریخ نامعتبر است")
}

/**
 * دسته‌بندی تسک — **اجباری**، و یا یک کلید canonical (preset) یا یک برچسب
 * سفارشی معتبر.
 *
 * قبلاً اینجا `z.enum` بود؛ حالا رشتهٔ trim‌شده‌ای می‌پذیرد که یا در واژگان
 * canonical است یا قاعدهٔ custom را گذرانده (طول، نبود markup، نبود هم‌پوشانی
 * با کلیدهای preset). غایب (undefined)، null، رشتهٔ خالی/فقط‌فاصله، غیررشته و
 * برچسب نامعتبر همچنان خطا هستند — یعنی «هیچ مسیر create موفقی با دستهٔ خالی
 * وجود ندارد» دست‌نخورده می‌ماند.
 *
 * `categoryIcon` در همین سطح جداگانه validate می‌شود: برای custom **اجباری** و
 * باید عضو allowlist باشد، برای preset **نباید** فرستاده شود (آیکن از واژگان
 * می‌آید و ذخیره نمی‌شود).
 *
 * این قید فقط در مرز create اعمال می‌شود؛ ستون DB همچنان nullable است تا
 * داده‌های legacy از بین نروند (بازبینی: نبود backfill عمدی).
 */
export const taskCategorySchema = z
    .string({ message: CATEGORY_REQUIRED_MESSAGE })
    .trim()
    .superRefine((value, ctx) => {
        if (classifyCategory(value) === "none") {
            ctx.addIssue({
                code: "custom",
                message: customLabelMessage(value),
            })
        }
    })

/** پیام خطای دقیق custom، برای اینکه کاربر بداند *چرا* رد شده است. */
function customLabelMessage(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length === 0) return CATEGORY_REQUIRED_MESSAGE
    if (trimmed.length < CUSTOM_CATEGORY_MIN_LENGTH || trimmed.length > CUSTOM_CATEGORY_MAX_LENGTH) {
        return CUSTOM_CATEGORY_LABEL_MESSAGE
    }
    if (trimmed.includes("<") || trimmed.includes(">")) return CUSTOM_CATEGORY_MARKUP_MESSAGE
    return CUSTOM_CATEGORY_RESERVED_MESSAGE
}

/**
 * جفت (category, categoryIcon) با قاعده‌های ترکیبی.
 * خروجی نرمال‌شده نیست (رشتهٔ خام) — نرمال‌سازی در `normalizeCategorySelection`
 * انجام می‌شود تا هر دو مسیر HTTP و سرویس دقیقاً یک قانون داشته باشند.
 */
const categorySelectionRefinement = (value: { category: unknown; categoryIcon?: string | null }, ctx: z.RefinementCtx) => {
    const kind = classifyCategory(value.category)
    if (kind === "custom") {
        if (value.categoryIcon == null) {
            ctx.addIssue({ code: "custom", path: ["categoryIcon"], message: CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE })
        } else if (!(CUSTOM_CATEGORY_ICONS as readonly string[]).includes(value.categoryIcon)) {
            ctx.addIssue({ code: "custom", path: ["categoryIcon"], message: CUSTOM_CATEGORY_ICON_INVALID_MESSAGE })
        }
    } else if (kind === "preset" && value.categoryIcon != null) {
        ctx.addIssue({ code: "custom", path: ["categoryIcon"], message: PRESET_ICON_FORBIDDEN_MESSAGE })
    }
}

const categoryIconField = z
    .string({ message: CUSTOM_CATEGORY_ICON_INVALID_MESSAGE })
    .nullish()

/**
 * فیلدهای مشترک دسته — به‌صورت شیء، نه `.shape`.
 *
 * استفاده از `.shape` روی یک شیءِ refinement‌شده refinementها را دور می‌ریزد
 * (فقط فیلدهای خام برمی‌گردند) و قاعدهٔ ترکیبیِ icon بی‌صدا حذف می‌شود. برای همین
 * شکل شیء اینجا جدا تعریف و بعد **روی همان شیء** refine می‌شود.
 */
const categoryShape = {
    category: taskCategorySchema,
    categoryIcon: categoryIconField,
}

/** قاعدهٔ ترکیبی مسیر PATCH — `category` اختیاری است، ولی icon بدون دسته پذیرفته نیست. */
function updateCategorySelectionRefinement(
    value: { category?: string | null; categoryIcon?: string | null },
    ctx: z.RefinementCtx,
) {
    if (value.category === undefined) {
        if (value.categoryIcon != null) {
            ctx.addIssue({
                code: "custom",
                path: ["category"],
                message: CATEGORY_ICON_WITHOUT_CATEGORY_MESSAGE,
            })
        }
        return
    }
    if (value.category === null) {
        // «حذف دسته» — icon هم باید پاک شود
        if (value.categoryIcon != null) {
            ctx.addIssue({
                code: "custom",
                path: ["categoryIcon"],
                message: PRESET_ICON_FORBIDDEN_MESSAGE,
            })
        }
        return
    }
    categorySelectionRefinement({ category: value.category, categoryIcon: value.categoryIcon }, ctx)
}

export function makeCreateTaskSchema(timezone: string) {
    return z.object({
        title: z
            .string()
            .trim()
            .min(1, "عنوان نمی‌تواند خالی باشد")
            .max(200, "عنوان خیلی طولانی است"),
        scheduledDate: makeScheduledDateField(timezone),
        // بدون `.optional()`/`.nullable()` — نبودن یا null عمداً خطاست
        ...categoryShape,
    })
        // قاعدهٔ ترکیبی روی خودِ شیء: custom بدون آیکن رد می‌شود و برای preset
        // ارسال آیکن خطاست.
        .superRefine(categorySelectionRefinement)
}

// فیلدهای مجاز ویرایش (C1): status، title، scheduledDate، category
// status فقط TODO/IN_PROGRESS — DONE از مسیر اختصاصی /complete (Time Tracking) انجام می‌شود
export function makeUpdateTaskSchema(timezone: string) {
    return z
        .object({
            title: z
                .string()
                .trim()
                .min(1, "عنوان نمی‌تواند خالی باشد")
                .max(200, "عنوان خیلی طولانی است")
                .optional(),
            status: z.enum(["TODO", "IN_PROGRESS"]).optional(),
            scheduledDate: makeScheduledDateField(timezone).optional(),
            // ویرایش هم همان قاعدهٔ create را می‌پذیرد (preset یا custom + آیکن)،
            // نه صرفاً واژگان canonical. null یعنی «حذف دسته» و مجاز است تا کاربر
            // بتواند یک تسک را به حالت بدون دسته برگرداند.
            category: taskCategorySchema.nullable().optional(),
            categoryIcon: categoryIconField,
        })
        .superRefine(updateCategorySelectionRefinement)
        .refine(
            (d) =>
                d.title !== undefined ||
                d.status !== undefined ||
                d.scheduledDate !== undefined ||
                d.category !== undefined,
            { message: "هیچ تغییری ارسال نشده است" },
        )
}

// C2 — اتمام تسک و Time Tracking (§3.10-C / §5.4.1)
// spentMinutes = مدت واقعی اعلام‌شده؛ عدد صحیح نامنفی.
// (بدون coerce — ورودی غیرعددی مثل "40" باید 400 برگرداند؛ سقف ۶۰۰ دقیقه = گارد موجود)
export const completeTaskSchema = z.object({
    spentMinutes: z
        .number()
        .int("مدت باید عدد صحیح باشد")
        .min(0, "مدت نمی‌تواند منفی باشد")
        .max(600, "مدت نمی‌تواند بیشتر از ۱۰ ساعت باشد"),
})