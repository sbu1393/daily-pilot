import {
    TICKET_BODY_MAX_LENGTH,
    TICKET_CATEGORY_KEYS,
    TICKET_MESSAGE_DEFAULT_PAGE_SIZE,
    TICKET_SUBJECT_MAX_LENGTH,
    ticketCategorySchema,
    ticketPrioritySchema,
    ticketStatusSchema,
    ticketUserPrioritySchema,
} from "@/app/schema/ticketSchema"
import { faDigits } from "@/app/lib/time"
import type {
    CreateTicketInput,
    SendTicketMessageInput,
    StaffTicketUpdateInput,
    TicketCategoryKey,
    TicketMessageView,
    TicketPriority,
    TicketStatus,
    TicketView,
    UserTicketUpdateInput,
} from "./ticketTypes"

// T5 — Ticket UI: لایهٔ منطقِ نمایش (Pure)
// ---------------------------------------------------------------
// الگوی رسمی مخزن برای تست UI بدون jsdom (همان روشی که `adminViewModels.ts` و
// `aiQuotaView.ts` توضیح داده‌اند): **منطقِ نمایش pure استخراج و تست می‌شود** و
// صفحه‌ها فقط render می‌کنند. این فایل هیچ I/O، DOM و React ندارد.
//
// ── سه قاعدهٔ حیاتی این لایه ────────────────────────────────────────────────
// ۱) **واژگان از schema فاز T2 مشتق می‌شود** (`ticketUserPrioritySchema.options`
//    و …). یعنی منوی اولویتِ کاربر *از تعریف رسمی* ساخته می‌شود، پس نه می‌تواند
//    `URGENT` را پیشنهاد دهد و نه با schema واگرا شود. منبع حقیقت همچنان API است؛
//    این فقط لایهٔ UX است.
// ۲) **payload سازنده‌ها allowlist است** (نه spread). یعنی حتی اگر یک شیء
//    پرآلوده به آن برسد، هیچ فیلد سرورکنترل‌شده‌ای (`userId`, `isStaff`,
//    `closedAt`, `role`, …) به body درخواست راه پیدا نمی‌کند.
// ۳) **این لایه مرز امنیتی نیست.** هیچ‌کدام از این توابع تصمیم دسترسی یا وضعیت
//    نمی‌گیرد؛ قوانین در سرویس/API enforce می‌شوند و UI فقط presentation است.

// ---------- واژگانِ مشتق‌شده از schema فاز T2 ----------

/** گزینه‌های اولویت برای **کاربر عادی** — `URGENT` عملاً در این آرایه وجود ندارد. */
export const TICKET_USER_PRIORITY_OPTIONS = ticketUserPrioritySchema.options
/** گزینه‌های اولویت کامل برای **کارمند**. */
export const TICKET_STAFF_PRIORITY_OPTIONS = ticketPrioritySchema.options
export const TICKET_STATUS_OPTIONS = ticketStatusSchema.options
export const TICKET_CATEGORY_OPTIONS = ticketCategorySchema.options

export const TICKET_SUBJECT_MAX = TICKET_SUBJECT_MAX_LENGTH
export const TICKET_BODY_MAX = TICKET_BODY_MAX_LENGTH

/**
 * اندازهٔ صفحهٔ گفتگو در UI — از تعریف فاز T2 خوانده می‌شود تا UI و API
 * ناهماهنگ نشوند (همان قاعدهٔ «واژگان از schema مشتق می‌شود»).
 */
export const TICKET_MESSAGE_PAGE_LIMIT = TICKET_MESSAGE_DEFAULT_PAGE_SIZE

// ---------- برچسب‌های فارسی ----------

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
    OPEN: "باز",
    PENDING: "در انتظار",
    CLOSED: "بسته",
}

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
    LOW: "کم",
    MEDIUM: "متوسط",
    HIGH: "زیاد",
    URGENT: "فوری",
}

export const TICKET_CATEGORY_LABELS: Record<TicketCategoryKey, string> = {
    bug: "اشکال فنی",
    billing: "پرداخت و اشتراک",
    account: "حساب کاربری",
    feature: "پیشنهاد قابلیت",
    question: "سؤال",
    other: "سایر",
}

export function ticketStatusLabel(status: TicketStatus): string {
    return TICKET_STATUS_LABELS[status] ?? status
}

export function ticketPriorityLabel(priority: TicketPriority): string {
    return TICKET_PRIORITY_LABELS[priority] ?? priority
}

/** دستهٔ ذخیره‌شده یک رشتهٔ معتبر است؛ برچسبش از واژگان T2 می‌آید و «بدون دسته» fallback دارد. */
export function ticketCategoryLabel(category: string | null | undefined): string {
    if (!category) return "بدون دسته"
    return TICKET_CATEGORY_LABELS[category as TicketCategoryKey] ?? category
}

/**
 * راهنمای متنیِ وضعیت، متناسب با نقشی که صفحه را می‌بیند.
 * `PENDING` از تعریف خودِ T1 می‌آید: «در انتظار پاسخ کاربر» بعد از پاسخ کارکنان.
 */
export function ticketStatusHint(status: TicketStatus, perspective: "user" | "staff"): string {
    if (status === "OPEN") return perspective === "user" ? "در انتظار بررسی تیم پشتیبانی" : "منتظر اولین پاسخ کارکنان"
    if (status === "PENDING") return perspective === "user" ? "پاسخ کارکنان ثبت شده؛ منتظر پاسخ شما" : "پاسخ داده شده؛ منتظر پاسخ کاربر"
    return "این تیکت بسته شده و امکان پیام تازه وجود ندارد"
}

// ---------- تاریخ ----------

const RELATIVE_UNITS: { limit: number; divisor: number; unit: string }[] = [
    { limit: 60_000, divisor: 1000, unit: "ثانیه" },
    { limit: 3_600_000, divisor: 60_000, unit: "دقیقه" },
    { limit: 86_400_000, divisor: 3_600_000, unit: "ساعت" },
]

function toPersianDigits(input: string): string {
    return input.replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])
}

/**
 * زمانِ خوانا برای نمایش در فهرست/گفتگو.
 * ورودی نامعتبر (null/string خراب) هرگز exception نمی‌دهد — فقط `null` می‌دهد تا
 * صفحه بتواند «—» نشان دهد.
 */
export function formatTicketTime(iso: string | null | undefined, now: number = Date.now()): string | null {
    if (!iso) return null
    const time = new Date(iso).getTime()
    if (Number.isNaN(time)) return null

    const diff = now - time
    if (diff >= 0 && diff < 86_400_000) {
        for (const { limit, divisor, unit } of RELATIVE_UNITS) {
            if (diff < limit) {
                const value = Math.max(1, Math.floor(diff / divisor))
                return `${toPersianDigits(String(value))} ${unit} پیش`
            }
        }
    }
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(time))
}

// ---------- وضعیت صفحه (loading / empty / error / data) ----------

export type TicketListStatus = "loading" | "empty" | "error" | "data"

export function resolveTicketListStatus(
    loading: boolean,
    error: string | null,
    itemCount: number,
): TicketListStatus {
    if (loading) return "loading"
    if (error !== null) return "error"
    return itemCount > 0 ? "data" : "empty"
}

// ---------- صفحه‌بندی (میلک‌شده به شکل AdminPagination) ----------

export interface TicketPaginationView {
    page: number
    totalPages: number
    hasPrev: boolean
    hasNext: boolean
}

/**
 * `hasMore` از API می‌آید و «صفحهٔ بعد وجود دارد» را بدون max-page شدنی می‌داند؛
 * `totalPages` هم فقط برای متنِ «صفحه‌ی X از Y» است و اگر total صفر باشد
 * حداقل ۱ نگه داشته می‌شود تا «صفحه‌ی ۱ از ۰» نمایش داده نشود.
 */
export function buildTicketPagination(
    page: number,
    limit: number,
    total: number,
    hasMore: boolean,
): TicketPaginationView {
    const safeLimit = limit > 0 ? limit : 1
    const safePage = page > 0 ? page : 1
    const totalPages = Math.max(1, Math.ceil((total > 0 ? total : 0) / safeLimit))
    return {
        page: safePage,
        totalPages,
        hasPrev: safePage > 1,
        hasNext: hasMore,
    }
}

// ---------- query string (allowlist؛ هیچ param خامی تزریق نمی‌شود) ----------

export interface TicketListQuery {
    page?: number
    limit?: number
    status?: TicketStatus | ""
}

export function buildTicketListQuery(query: TicketListQuery): string {
    const sp = new URLSearchParams()
    if (query.status && TICKET_STATUS_OPTIONS.includes(query.status)) {
        sp.set("status", query.status)
    }
    sp.set("page", String(Math.max(1, Math.floor(query.page ?? 1))))
    sp.set("limit", String(Math.max(1, Math.floor(query.limit ?? 20))))
    return sp.toString()
}

// ---------- query string گفتگو (R1) ----------

export interface TicketMessagesQuery {
    page?: number
    limit?: number
}

/**
 * `messagesPage`/`messagesLimit` — همان دو پارامتری که schema فاز T2 می‌خواند.
 * مثل `buildTicketListQuery` فقط همین دو کلید ساخته می‌شوند (allowlist) و هر دو
 * به عدد صحیح ≥ ۱ کلاب می‌شوند، پس query هرگز خراب یا تزریق‌شده نمی‌شود.
 */
export function buildTicketMessagesQuery(query: TicketMessagesQuery = {}): string {
    const sp = new URLSearchParams()
    sp.set("messagesPage", String(Math.max(1, Math.floor(query.page ?? 1))))
    sp.set(
        "messagesLimit",
        String(Math.max(1, Math.floor(query.limit ?? TICKET_MESSAGE_DEFAULT_PAGE_SIZE))),
    )
    return sp.toString()
}

/**
 * متنِ بازهٔ نمایش‌داده‌شده: «نمایش ۱ تا ۲۰ از ۵۰ پیام».
 *
 * هر دو سرِ بازه داخل `[1, total]` کلاب می‌شوند: نه صفحهٔ آخر از حد می‌زند
 * («۴۱ تا ۵۰ از ۵۰») و نه صفحه‌ای که از انتها گذشته عددی خیالی نشان می‌دهد.
 * اگر `total` صفر/نامعتبر باشد «بدون پیام» برمی‌گردد تا «۰ تا ۰» نمایش داده
 * نشود — و NaN/Infinity هرگز exception نمی‌دهد.
 */
export function buildMessageThreadLabel(page: number, limit: number, total: number): string {
    if (!Number.isFinite(total) || total <= 0) return "بدون پیام"
    const safeTotal = Math.floor(total)
    const safeLimit =
        Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : TICKET_MESSAGE_DEFAULT_PAGE_SIZE
    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1

    const from = Math.min(Math.max((safePage - 1) * safeLimit + 1, 1), safeTotal)
    const to = Math.min(safePage * safeLimit, safeTotal)
    return `نمایش ${faDigits(from)} تا ${faDigits(to)} از ${faDigits(safeTotal)} پیام`
}

// ---------- ترجمهٔ خطا (کد داخلی هرگز به کاربر نشان داده نمی‌شود) ----------

const TICKET_ERROR_MESSAGES: Record<string, string> = {
    TICKET_NOT_FOUND: "این تیکت پیدا نشد یا به شما تعلق ندارد.",
    TICKET_FORBIDDEN: "برای این کار دسترسی ندارید.",
    TICKET_CLOSED: "این تیکت بسته شده است و امکان ارسال پیام یا تغییر آن وجود ندارد.",
    TICKET_INVALID_TRANSITION: "این تغییر وضعیت برای تیکتِ فعلی ممکن نیست.",
    TICKET_CONFLICT: "هم‌زمان تغییری روی این تیکت انجام شده؛ صفحه را تازه کنید و دوباره تلاش کنید.",
    VALIDATION_ERROR: "اطلاعات وارد‌شده معتبر نیست.",
    UNAUTHORIZED: "نشست شما معتبر نیست؛ دوباره وارد شوید.",
    ADMIN_FORBIDDEN: "برای این بخش دسترسی مدیریتی لازم است.",
    INTERNAL: "خطای غیرمنتظره رخ داد؛ دوباره تلاش کنید.",
}

/** پیامِ قابل‌نمایش برای هر خطا. ورودی ناشناخته ⇒ پیام عمومی (نه code خام). */
export function ticketErrorMessage(error: unknown): string {
    const code =
        typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : null
    if (code !== null && TICKET_ERROR_MESSAGES[code] !== undefined) return TICKET_ERROR_MESSAGES[code]
    if (error instanceof Error && error.message.length > 0) return error.message
    return "خطای ناشناخته؛ دوباره تلاش کنید."
}

/** آیا خطا یعنی «باید دوباره تلاش کن»؟ (برای دکمهٔ retry در UI). */
export function isRetryableTicketError(error: unknown): boolean {
    const code =
        typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : null
    return code === "TICKET_CONFLICT" || code === "INTERNAL"
}

// ---------- وضعیتِ composer (فقط presentation) ----------

/**
 * آیا composer پیام باید نمایش/فعال باشد؟
 *
 * این **قابلیت‌پذیری** است، نه اجازه: تنها دلیلش وضعیت نمایشی `CLOSED` است که از
 * خودِ پاسخ API آمده. تصمیم نهایی همچنان در سرویس است (`TicketClosedError`)،
 * پس حتی اگر این تابع اشتباه کند یا دور زده شود، چیزی دور زده نمی‌شود.
 */
export function canReplyToTicket(status: TicketStatus): boolean {
    return status !== "CLOSED"
}

// ---------- نگاشتِ ردیف فهرست ----------

export interface TicketRowView {
    id: number
    subject: string
    status: TicketStatus
    statusLabel: string
    priority: TicketPriority
    priorityLabel: string
    categoryLabel: string
    updatedLabel: string | null
}

export function buildTicketRow(ticket: TicketView, now?: number): TicketRowView {
    return {
        id: ticket.id,
        subject: ticket.subject,
        status: ticket.status,
        statusLabel: ticketStatusLabel(ticket.status),
        priority: ticket.priority,
        priorityLabel: ticketPriorityLabel(ticket.priority),
        categoryLabel: ticketCategoryLabel(ticket.category),
        updatedLabel: formatTicketTime(ticket.lastMessageAt ?? ticket.updatedAt, now),
    }
}

export interface TicketMessageRowView {
    id: string
    body: string
    isStaff: boolean
    authorLabel: string
    timeLabel: string | null
}

export function buildTicketMessages(
    messages: TicketMessageView[],
    now?: number,
): TicketMessageRowView[] {
    return messages.map((m) => ({
        id: m.id,
        body: m.body,
        isStaff: m.isStaff,
        // برچسب نقش از snapshot سمت سرور می‌آید (`isStaff`) — UI حدس نمی‌زند
        // کاربر admin است یا نه، چون اطلاعات نقشِ نویسنده در پاسخ API نیست.
        authorLabel: m.isStaff ? "پشتیبانی" : "شما",
        timeLabel: formatTicketTime(m.createdAt, now),
    }))
}

// ---------- سازنده‌های payload (allowlist؛ بدون spread) ----------

export interface CreateTicketDraft {
    subject?: string
    body?: string
    category?: string
    priority?: string
}

/**
 * بدنهٔ `POST /api/tickets`.
 *
 * میدان‌به‌میدان ساخته می‌شود؛ `userId`/`status`/`closedAt`/`isStaff`/`role`
 * حتی اگر در draft حاضر باشند **هرگز** وارد body نمی‌شوند.
 */
export function buildCreateTicketPayload(draft: CreateTicketDraft): CreateTicketInput {
    const subject = (draft.subject ?? "").trim()
    const body = (draft.body ?? "").trim()
    const payload: CreateTicketInput = { subject, body }

    const category = TICKET_CATEGORY_KEYS.find((key) => key === draft.category)
    if (category !== undefined) payload.category = category

    // `find` روی واژگان کاربر ⇒ `URGENT` (یا هر رشتهٔ دیگری) اصلاً عبور نمی‌کند.
    const priority = TICKET_USER_PRIORITY_OPTIONS.find((option) => option === draft.priority)
    if (priority !== undefined) payload.priority = priority

    return payload
}

/** بدنهٔ `PATCH /api/tickets/[id]` — فقط priority و category (status ندارد). */
export function buildUserTicketUpdatePayload(draft: {
    priority?: string | null
    category?: string | null
}): UserTicketUpdateInput {
    const payload: UserTicketUpdateInput = {}

    const priority = TICKET_USER_PRIORITY_OPTIONS.find((option) => option === draft.priority)
    if (priority !== undefined) payload.priority = priority

    if (draft.category === "") {
        payload.category = null
    } else {
        const category = TICKET_CATEGORY_KEYS.find((key) => key === draft.category)
        if (category !== undefined) payload.category = category
    }

    return payload
}

/** بدنهٔ `PATCH /api/admin/tickets/[id]` — اینجا `URGENT` و `status` مجازند. */
export function buildStaffTicketUpdatePayload(draft: {
    status?: string | null
    priority?: string | null
    category?: string | null
}): StaffTicketUpdateInput {
    const payload: StaffTicketUpdateInput = {}

    const status = TICKET_STATUS_OPTIONS.find((option) => option === draft.status)
    if (status !== undefined) payload.status = status

    const priority = TICKET_STAFF_PRIORITY_OPTIONS.find((option) => option === draft.priority)
    if (priority !== undefined) payload.priority = priority

    if (draft.category === "") {
        payload.category = null
    } else {
        const category = TICKET_CATEGORY_KEYS.find((key) => key === draft.category)
        if (category !== undefined) payload.category = category
    }

    return payload
}

/** بدنهٔ ارسال پیام — فقط `body` (trim‌شده). */
export function buildTicketMessagePayload(body: string): SendTicketMessageInput {
    return { body: body.trim() }
}
