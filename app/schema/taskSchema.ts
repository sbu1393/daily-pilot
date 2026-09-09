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

const scheduledDateField = z
    .union([
        dateOnlyString,
        z.string().datetime({ offset: true, message: "تاریخ نامعتبر است" }),
        z.number(),
    ])
    .transform((v) => new Date(v))
    .refine((d) => !Number.isNaN(d.getTime()), "تاریخ نامعتبر است")

export const createTaskSchema = z.object({
    title: z
        .string()
        .trim()
        .min(1, "عنوان نمی‌تواند خالی باشد")
        .max(200, "عنوان خیلی طولانی است"),
    scheduledDate: scheduledDateField,
})

// فیلدهای مجاز ویرایش (C1): status، title، scheduledDate، category
// status فقط TODO/IN_PROGRESS — DONE از مسیر اختصاصی /complete (Time Tracking) انجام می‌شود
export const updateTaskSchema = z
    .object({
        title: z
            .string()
            .trim()
            .min(1, "عنوان نمی‌تواند خالی باشد")
            .max(200, "عنوان خیلی طولانی است")
            .optional(),
        status: z.enum(["TODO", "IN_PROGRESS"]).optional(),
        scheduledDate: scheduledDateField.optional(),
        category: z
            .string()
            .trim()
            .min(1, "دسته‌بندی خالی است")
            .max(30, "دسته‌بندی حداکثر ۳۰ کاراکتر است")
            .nullable()
            .optional(),
    })
    .refine(
        (d) =>
            d.title !== undefined ||
            d.status !== undefined ||
            d.scheduledDate !== undefined ||
            d.category !== undefined,
        { message: "هیچ تغییری ارسال نشده است" },
    )

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