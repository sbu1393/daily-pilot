import { z } from "zod"
import { faDigits } from "@/app/lib/time"

// T2 — Ticketing input validation (مرز ورودی HTTP)
// -------------------------------------------------
// این فایل **تنها** لایهٔ اعتبارسنجیِ ورودیِ Ticketing است و عمداً هیچ چیزی از
// مالکیت/RBAC/وجود رکورد/گذارِ وضعیت را انجام نمی‌دهد. آن‌ها وظیفهٔ لایهٔ سرویس‌اند:
//
//   در Zod:  نوع، شکل، اجباری/اختیاری، طول رشته، دامنهٔ enum، پارس pagination
//   خارج از Zod: ownership، RBAC، IDOR، state transition، وجود رکورد،
//                نوتیفیکیشن، تراکنش
//
// مدل‌ها و enumها دقیقاً با `prisma/schema.prisma` (افزوده‌های T1) هم‌راستا هستند.
// هیچ استقلالِ معنایی جدید یا گذارِ وضعیتی اینجا کد نمی‌شود.

// ── Status / Priority ────────────────────────────────────────────────────────
// منبع حقیقت: enumهای Prisma از T1. عین همین مقادیر، بدون rename
// (MEDIUM هرگز به NORMAL تغییر نمی‌کند) و بدون گذار وضعیت.
export const ticketStatusSchema = z.enum(["OPEN", "PENDING", "CLOSED"])

/** enum کامل — برای مسیرهای سرور/پشتیبانی (update). */
export const ticketPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"])

/**
 * اولویتِ مجاز هنگام **ایجاد تیکت توسط کاربر**.
 *
 * `URGENT` عمداً حذف شده است: فوریتِ واقعی باید توسط پشتیبانی تعیین شود، وگرنه
 * هر کاربری می‌تواند خودش را escalate کند. این یک قاعدهٔ مرزِ ورودی است، نه یک
 * جدول یا مکانیزم جدید؛ سرویس می‌تواند در آینده آن را به کل enum ارتقا دهد.
 */
export const ticketUserPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH"])

// ── Category ─────────────────────────────────────────────────────────────────
// T1 عمداً `category String?` است (بدون جدول TicketCategory).
//
// واژگان `app/lib/categories.ts` برای **تسک** است (خانه/کار/خرید/…) و به موضوعِ
// تیکتِ پشتیبانی نگاشت نمی‌شود؛ استفادهٔ مجدد آن دو دامنهٔ بی‌ربط را کوپل می‌کند.
// پس اینجا یک لایهٔ اعتبارسنجیِ کوچکِ مخصوصِ تیکت تعریف می‌شود (کلید انگلیسی،
// همان الگوی ذخیرهٔ تسک). هیچ مدل Prisma/CRUD/migration جدیدی ساخته نمی‌شود؛
// ستون همچنان `String?` و nullable است.
export const TICKET_CATEGORY_KEYS = [
    "bug",
    "billing",
    "account",
    "feature",
    "question",
    "other",
] as const

export type TicketCategoryKey = (typeof TICKET_CATEGORY_KEYS)[number]

export const TICKET_CATEGORY_INVALID_MESSAGE = "دسته‌بندی انتخابی معتبر نیست"

/** گارد نوعی برای مرزهای غیرقابل‌اعتماد — هرگز throw نمی‌کند. */
export function isTicketCategoryKey(value: unknown): value is TicketCategoryKey {
    return (
        typeof value === "string" &&
        (TICKET_CATEGORY_KEYS as readonly string[]).includes(value)
    )
}

export const ticketCategorySchema = z.enum(TICKET_CATEGORY_KEYS, {
    message: TICKET_CATEGORY_INVALID_MESSAGE,
})

// ── طول‌ها و پیام‌ها ─────────────────────────────────────────────────────────
// طبق قرارداد `app/lib/taskTitle.ts`: عدد و پیامش از یک‌جا می‌آیند تا هرگز
// ناهماهنگ نشوند. مقدار از این ماژول export می‌شود تا UI هم همان را بخواند.
export const TICKET_SUBJECT_MAX_LENGTH = 120
export const TICKET_BODY_MAX_LENGTH = 5000

export const TICKET_SUBJECT_REQUIRED_MESSAGE = "موضوع تیکت نمی‌تواند خالی باشد"
export const TICKET_SUBJECT_TOO_LONG_MESSAGE =
    `موضوع تیکت نمی‌تواند بیشتر از ${faDigits(TICKET_SUBJECT_MAX_LENGTH)} کاراکتر باشد.`
export const TICKET_BODY_REQUIRED_MESSAGE = "متن پیام نمی‌تواند خالی باشد"
export const TICKET_BODY_TOO_LONG_MESSAGE =
    `متن پیام نمی‌تواند بیشتر از ${faDigits(TICKET_BODY_MAX_LENGTH)} کاراکتر باشد.`
export const TICKET_NO_CHANGES_MESSAGE = "هیچ تغییری ارسال نشده است"
export const TICKET_ID_INVALID_MESSAGE = "شناسه نامعتبر است"

/** فیلد مشترک subject — trim + non-empty + سقف طول. */
const ticketSubjectSchema = z
    .string({ message: TICKET_SUBJECT_REQUIRED_MESSAGE })
    .trim()
    .min(1, TICKET_SUBJECT_REQUIRED_MESSAGE)
    .max(TICKET_SUBJECT_MAX_LENGTH, TICKET_SUBJECT_TOO_LONG_MESSAGE)

/** فیلد مشترک بدنهٔ پیام — trim + non-empty + سقف طول. */
const ticketBodySchema = z
    .string({ message: TICKET_BODY_REQUIRED_MESSAGE })
    .trim()
    .min(1, TICKET_BODY_REQUIRED_MESSAGE)
    .max(TICKET_BODY_MAX_LENGTH, TICKET_BODY_TOO_LONG_MESSAGE)

// ── Ticket ID ────────────────────────────────────────────────────────────────
// مدل `Ticket.id` یک Int autoincrement است. هیچ schema عددیِ قابل‌استفادهٔ مجددی
// در مخزن نبود؛ کوچک‌ترین گارد مناسب: عدد صحیح مثبت، با coerce برای param روت.
export const ticketIdSchema = z.coerce
    .number({ message: TICKET_ID_INVALID_MESSAGE })
    .int(TICKET_ID_INVALID_MESSAGE)
    .positive(TICKET_ID_INVALID_MESSAGE)

// ── Pagination ───────────────────────────────────────────────────────────────
// همان قرارداد مخزن: `page` + `limit` (بدون cursor). مقادیر query همیشه رشته‌اند،
// پس coerce لازم است؛ پیش‌فرض‌ها هم‌راستا با سقف‌های رایج (مثل adminAudit).
export const TICKET_DEFAULT_PAGE_SIZE = 20
export const TICKET_MAX_PAGE_SIZE = 100

export const ticketListQuerySchema = z.object({
    page: z.coerce
        .number()
        .int("شمارهٔ صفحه باید عدد صحیح باشد")
        .min(1, "شمارهٔ صفحه باید حداقل ۱ باشد")
        .default(1),
    limit: z.coerce
        .number()
        .int("تعداد در هر صفحه باید عدد صحیح باشد")
        .min(1, "تعداد در هر صفحه باید حداقل ۱ باشد")
        .max(TICKET_MAX_PAGE_SIZE, `تعداد در هر صفحه نمی‌تواند بیشتر از ${faDigits(TICKET_MAX_PAGE_SIZE)} باشد`)
        .default(TICKET_DEFAULT_PAGE_SIZE),
    // تنها فیلتر لازم برای «فهرست تیکت‌های من»؛ عمداً سیستم فیلتر بزرگ ساخته نمی‌شود.
    status: ticketStatusSchema.optional(),
})

// ── Pagination of the message thread (R1 — bounded read) ─────────────────────
// `GET /api/tickets/[id]` قبلاً **همهٔ** پیام‌های تیکت را بدون سقف برمی‌گرداند؛
// یک تیکتِ قدیمی می‌توانست کل صفحه را از آب دربیاورد. حالا همان قرارداد
// `page`/`limit` مخزن (بدون cursor) روی خودِ گفتگو هم اعمال می‌شود.
//
// نام‌ها `messagesPage`/`messagesLimit` هستند تا با query فهرستِ تیکت‌ها
// (`page`/`limit`) قاطی نشوند: یک endpoint، یک جفت پارامتر.
//
// سقف‌ها عمداً هم‌ارزِ فهرست تیکت‌اند (`TICKET_MAX_PAGE_SIZE`): یک policy
// pagination جدید و ناسازگار اختراع نمی‌شود.
export const TICKET_MESSAGE_DEFAULT_PAGE_SIZE = TICKET_DEFAULT_PAGE_SIZE
export const TICKET_MESSAGE_MAX_PAGE_SIZE = TICKET_MAX_PAGE_SIZE

export const ticketMessagePageQuerySchema = z.object({
    messagesPage: z.coerce
        .number()
        .int("شمارهٔ صفحهٔ پیام‌ها باید عدد صحیح باشد")
        .min(1, "شمارهٔ صفحهٔ پیام‌ها باید حداقل ۱ باشد")
        .default(1),
    messagesLimit: z.coerce
        .number()
        .int("تعداد پیام در هر صفحه باید عدد صحیح باشد")
        .min(1, "تعداد پیام در هر صفحه باید حداقل ۱ باشد")
        .max(
            TICKET_MESSAGE_MAX_PAGE_SIZE,
            `تعداد پیام در هر صفحه نمی‌تواند بیشتر از ${faDigits(TICKET_MESSAGE_MAX_PAGE_SIZE)} باشد`,
        )
        .default(TICKET_MESSAGE_DEFAULT_PAGE_SIZE),
})

// ── POST: ایجاد تیکت ─────────────────────────────────────────────────────────
// کاربر عادی یک تیکت جدید می‌سازد: موضوع + اولین پیام اجباری، دسته/اولویت اختیاری.
// `.strict()` یعنی هر کلید ناشناس (userId/status/isStaff/closedAt/…) رد می‌شود،
// نه بی‌صدا حذف؛ پس هیچ مسیر «فیلد اضافه را دور بزن» باقی نمی‌ماند.
export const createTicketSchema = z
    .object({
        subject: ticketSubjectSchema,
        body: ticketBodySchema,
        category: ticketCategorySchema.optional(),
        priority: ticketUserPrioritySchema.optional(),
    })
    .strict()

// ── POST: افزودن پیام ───────────────────────────────────────────────────────
// کلاینت فقط `body` می‌فرستد. `ticketId`، `authorUserId`، `isStaff`، `status` و
// `closedAt` فیلدهای سرورکنترل‌شده‌اند و با `.strict()` صریحاً رد می‌شوند.
export const addTicketMessageSchema = z
    .object({
        body: ticketBodySchema,
    })
    .strict()

// ── PATCH: ویرایش تیکت (سرور/پشتیبانی) ──────────────────────────────────────
// فقط فیلدهای سرورکنترل‌شدهٔ مجاز: status، priority، category (null = پاک‌کردن).
// هیچ فیلد مالکیت/نویسنده/واگذاری پذیرفته نمی‌شود (userId/authorUserId/isStaff/
// assignedToUserId) — و چون `assignedToUserId` در schema وجود ندارد، assignment
// هم اصلاً پیاده‌سازی نمی‌شود. گذارِ وضعیت اینجا اعمال نمی‌شود؛ فقط دامنهٔ enum.
export const updateTicketSchema = z
    .object({
        status: ticketStatusSchema.optional(),
        priority: ticketPrioritySchema.optional(),
        category: ticketCategorySchema.nullable().optional(),
    })
    .strict()
    .refine(
        (d) => d.status !== undefined || d.priority !== undefined || d.category !== undefined,
        { message: TICKET_NO_CHANGES_MESSAGE },
    )

// ── Types (برای فاز T3) ──────────────────────────────────────────────────────
export type TicketStatusInput = z.infer<typeof ticketStatusSchema>
export type TicketPriorityInput = z.infer<typeof ticketPrioritySchema>
export type CreateTicketInput = z.infer<typeof createTicketSchema>
export type AddTicketMessageInput = z.infer<typeof addTicketMessageSchema>
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>
export type TicketListQueryInput = z.infer<typeof ticketListQuerySchema>
export type TicketMessagePageQueryInput = z.infer<typeof ticketMessagePageQuerySchema>
