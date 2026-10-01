import { getPrisma } from "@/app/lib/getPrisma"
import type { Prisma, Ticket, TicketMessage, UserRole } from "@prisma/client"

import {
    TICKET_CATEGORY_INVALID_MESSAGE,
    TICKET_DEFAULT_PAGE_SIZE,
    TICKET_MESSAGE_DEFAULT_PAGE_SIZE,
    TICKET_NO_CHANGES_MESSAGE,
    isTicketCategoryKey,
    ticketPrioritySchema,
    ticketUserPrioritySchema,
    type AddTicketMessageInput,
    type CreateTicketInput,
    type TicketListQueryInput,
    type TicketMessagePageQueryInput,
    type TicketPriorityInput,
    type TicketStatusInput,
    type UpdateTicketInput,
} from "@/app/schema/ticketSchema"

import {
    ServiceError,
    TicketClosedError,
    TicketConflictError,
    TicketForbiddenError,
    TicketInvalidTransitionError,
    TicketNoChangesError,
    TicketNotFoundError,
} from "./errors"

// T3 — Ticket service: ownership · IDOR · RBAC · state machine · atomicity
// ------------------------------------------------------------------------
// این لایه **مرز امنیتیِ enforcement** است، نه فقط لایهٔ DB access. Routeها
// مجازند `requireVerifiedUser()` / `requireAdmin()` را صدا بزنند، ولی تصمیمِ
// نهایی همیشه اینجا گرفته می‌شود تا با یک route جدید دور زده نشود.
//
// ── چرا `TicketActor` و نه `userId: number`؟ ────────────────────────────────
// تسک‌ها فقط به `userId` نیاز داشتند چون هر عملیات مالک‌محور بود. تیکت دو محور
// دارد: **مالکیت** (id) و **نقش** (role). نقش از `User.role` در DB می‌آید — همان
// منبعِ واحدی که `requireAdmin` (`app/lib/requireAdmin.ts`) روی آن تکیه می‌کند.
// هیچ نقش/permission موازی‌ای ساخته نشده: پروژه فقط `enum UserRole { USER ADMIN }`
// دارد و در T1 صریحاً قید شده «دسترسی کارکنان فقط با نقش ADMIN». پس «staff» در
// این سرویس = `ADMIN`، دقیقاً همان قرارداد `requireAdmin`.
//
// ── منبع policy وضعیت ───────────────────────────────────────────────────────
// جدول `TICKET_STATUS_TRANSITIONS` از خودِ specification پروژه استخراج شده و
// اختراعی نیست:
//   • `prisma/schema.prisma` (توضیح `TicketStatus`): «`PENDING` = در انتظار پاسخ
//     کاربر، **پس از پاسخ کارکنان**». یعنی `OPEN → PENDING` دقیقاً وقتی رخ می‌دهد
//     که کارمند پاسخ داده باشد، و `PENDING → OPEN` وقتی کاربر پاسخ دهد (دیگر
//     «در انتظار پاسخ کاربر» نیست). این transitionها در `addTicketMessage` به‌صورت
//     **سرورکنترل‌شده** اعمال می‌شوند، نه با فیلد client.
//   • `CLOSED` وضعیت پایانی است؛ هیچ transition خروجی ندارد (مگر no-op روی خودش).
//   • تغییر وضعیت فقط در اختیار staff است؛ client هیچ‌وقت `status` را مستقیم
//     تعیین نمی‌کند مگر از مسیر staff-only که خودش enforcement می‌شود.

/** actor احراز‌هویت‌شده — `role` همیشه از DB (`User.role`) خوانده می‌شود. */
export interface TicketActor {
    id: number
    role: UserRole
}

/** کارمند = ADMIN. عمداً همان شرط `requireAdmin`؛ نقش جدیدی (SUPPORT) ساخته نمی‌شود. */
export function isTicketStaff(actor: TicketActor): boolean {
    return actor.role === "ADMIN"
}

/**
 * جدول گذار — تنها منبع حقیقتِ state machine.
 *
 *   OPEN    → PENDING (کارمند پاسخ داد) · CLOSED (کارمند بست)
 *   PENDING → OPEN (کاربر پاسخ داد) · CLOSED (کارمند بست)
 *   CLOSED  → (پایانی؛ بدون خروج)
 *
 * `from === to` یک **no-op** مجاز است، نه یک transition: UI معمولاً وضعیت فعلی را
 * دوباره ارسال می‌کند و این نباید 409 بدهد. هیچ policy‌ای را دور نمی‌زند چون
 * `CLOSED` همیشه `CLOSED` می‌ماند و `closedAt` دست‌نخورده می‌ماند.
 */
export const TICKET_STATUS_TRANSITIONS: Record<TicketStatusInput, readonly TicketStatusInput[]> = {
    OPEN: ["PENDING", "CLOSED"],
    PENDING: ["OPEN", "CLOSED"],
    CLOSED: [],
}

export function canTransitionTicketStatus(from: TicketStatusInput, to: TicketStatusInput): boolean {
    return from === to || TICKET_STATUS_TRANSITIONS[from].includes(to)
}

/** fail-fast: گذارِ نامعتبر → 409 (نه 400 و نه پیامِ افشاگر). */
export function assertTicketStatusTransition(from: TicketStatusInput, to: TicketStatusInput): void {
    if (!canTransitionTicketStatus(from, to)) throw new TicketInvalidTransitionError()
}

/**
 * گذارِ خودکارِ وضعیت بعد از ثبت یک پیام — **server-controlled**.
 *
 * از تعریف `PENDING` در schema نتیجه می‌شود: تا وقتی کارمند پاسخ نداده، تیکت
 * «در انتظار پاسخ کاربر» است؛ به‌محض پاسخ کاربر دیگر نیست و باید به `OPEN` برگردد.
 * هیچ‌کدام از این‌ها فیلدِ client نیستند.
 */
function resolveStatusAfterReply(status: TicketStatusInput, staff: boolean): TicketStatusInput {
    if (status === "CLOSED") return "CLOSED"
    if (staff) return status === "OPEN" ? "PENDING" : status
    return status === "PENDING" ? "OPEN" : status
}

// ---------- Guards (fail-fast برای callerهای غیر-HTTP) ----------

function assertActor(actor: TicketActor): void {
    if (!actor || !Number.isInteger(actor.id) || actor.id <= 0) throw new TicketForbiddenError()
}

function assertTicketId(ticketId: number): void {
    if (!Number.isInteger(ticketId) || ticketId <= 0) throw new TicketNotFoundError()
}

/**
 * اولویت: واژگان کاربر از همان enum فاز T2 خوانده می‌شود (بدون تکرار آرایه) و
 * `URGENT` فقط در اختیار staff است — escalation خودسر از سمت کاربر ممکن نیست.
 */
function assertPriorityWritable(actor: TicketActor, priority: TicketPriorityInput): void {
    const valid = ticketPrioritySchema.safeParse(priority)
    if (!valid.success) {
        throw new ServiceError(400, "VALIDATION_ERROR", "اطلاعات نامعتبر است", valid.error.issues, "VALIDATION", "INFO")
    }
    if (!isTicketStaff(actor) && !ticketUserPrioritySchema.safeParse(priority).success) {
        throw new TicketForbiddenError()
    }
}

/** دسته: `null` یعنی «پاک‌کردن» و مجاز است؛ هر رشتهٔ دیگری باید عضو واژگان T2 باشد. */
function assertCategoryWritable(category: string | null | undefined): void {
    if (category == null) return
    if (!isTicketCategoryKey(category)) {
        throw new ServiceError(400, "VALIDATION_ERROR", TICKET_CATEGORY_INVALID_MESSAGE, undefined, "VALIDATION", "INFO")
    }
}

// ---------- Ownership: تنها نقطهٔ resolve مالکیت ----------

/**
 * resolve برای یک actor.
 *
 * کاربر عادی: `findFirst({ id, userId })` — یعنی مالکیت **در همان query** اعمال
 * می‌شود و رکوردِ کاربرِ دیگر هرگز به لایهٔ بالا نمی‌رسد (IDOR بسته در query).
 * staff: `findFirst({ id })` — همهٔ تیکت‌ها.
 *
 * در هر دو حالت «پیدا نشد» و «مال کاربر نیست» یک `TicketNotFoundError` است، پس
 * وجودِ تیکتِ دیگران از رفتار بیرونی افشا نمی‌شود.
 */
async function resolveTicketForActor(actor: TicketActor, ticketId: number): Promise<Ticket> {
    assertActor(actor)
    assertTicketId(ticketId)
    const where = isTicketStaff(actor) ? { id: ticketId } : { id: ticketId, userId: actor.id }
    const ticket = await getPrisma().ticket.findFirst({ where })
    if (!ticket) throw new TicketNotFoundError()
    return ticket
}

// ---------- Atomicity: compare-and-set روی وضعیت ----------

/**
 * نوشتنِ شرطی (CAS) — قلبِ ضد-race این سرویس.
 *
 * الگوی ممنوع (`SELECT → check → UPDATE` بدون شرط) اینجا استفاده نشده: شرطِ
 * وضعیتِ مشاهده‌شده **داخل همان UPDATE** تکرار می‌شود، پس اگر درخواستِ موازی
 * وضعیت را عوض کرده باشد `updateMany` صفر ردیف می‌زند و ما 409 می‌دهیم به‌جای
 * اینکه policy را روی state کهنه اعمال کنیم. خطا داخل callback تراکنش throw
 * می‌شود ⇒ rollback کامل (پیامِ نوشته‌شده هم برمی‌گردد).
 */
async function casUpdateTicket(
    tx: Prisma.TransactionClient,
    ticket: Ticket,
    patch: Prisma.TicketUncheckedUpdateInput,
): Promise<Ticket> {
    const result = await tx.ticket.updateMany({
        where: { id: ticket.id, status: ticket.status },
        data: patch,
    })
    if (result.count === 0) throw new TicketConflictError()

    const updated = await tx.ticket.findUnique({ where: { id: ticket.id } })
    if (!updated) throw new TicketConflictError()
    return updated
}

// ---------- API سرویس ----------

export interface CreateTicketResult {
    ticket: Ticket
    /** اولین پیام؛ هم‌زمان و در همان تراکنشِ ساخت تیکت ثبت می‌شود. */
    message: TicketMessage
}

export interface TicketListResult {
    items: Ticket[]
    page: number
    limit: number
    total: number
    hasMore: boolean
}

/**
 * ایجاد تیکت + اولین پیام، اتمیک.
 *
 * فیلدهای سرورکنترل‌شده هرگز از `input` نمی‌آیند: `userId` از `actor.id`،
 * `authorUserId`/`isStaff` از actor، و `status`/`closedAt` اصلاً نوشته نمی‌شوند
 * (پیشفرض DB یعنی `OPEN` و `null`). حتی اگر یک caller غیر-TypeScript کلیدهای
 * اضافه رد کند، چون patch **میدان‌به‌میدان** ساخته می‌شود هیچ‌کدام به `data` نمی‌رسند
 * (mass-assignment وجود ندارد).
 */
export async function createTicket(
    actor: TicketActor,
    input: CreateTicketInput,
): Promise<CreateTicketResult> {
    assertActor(actor)
    if (input.priority !== undefined) assertPriorityWritable(actor, input.priority)
    assertCategoryWritable(input.category)

    const prisma = getPrisma()
    const now = new Date()

    return await prisma.$transaction(async (tx) => {
        const ticket = await tx.ticket.create({
            data: {
                userId: actor.id,
                subject: input.subject,
                // اختیاری‌ها فقط وقتی واقعاً ارسال شده‌اند (بدون overwriting پیشفرض DB)
                ...(input.category != null ? { category: input.category } : {}),
                ...(input.priority != null ? { priority: input.priority } : {}),
                lastMessageAt: now,
            },
        })

        const message = await tx.ticketMessage.create({
            data: {
                ticketId: ticket.id,
                authorUserId: actor.id,
                body: input.body,
                isStaff: isTicketStaff(actor),
                createdAt: now,
            },
        })

        return { ticket, message }
    })
}

export type TicketWithMessages = Ticket & { messages: TicketMessage[] }

/** متادیتای صفحهٔ گفتگو — همان شکل `{page, limit, total, hasMore}` که `listTickets` می‌دهد. */
export interface TicketMessagePage {
    page: number
    limit: number
    total: number
    hasMore: boolean
}

export interface TicketDetailResult {
    /** متادیتای تیکت + **فقط** پیام‌های همین صفحه (`ticket.messages`). */
    ticket: TicketWithMessages
    messagePage: TicketMessagePage
}

/**
 * خواندن یک تیکت + پیام‌هایش (قدیمی به جدید) — **با سقف**.
 *
 * R1: قبلاً `include.messages` بدون `take` بود، پس یک تیکتِ قدیمی کل payload را
 * می‌کشید. حالا همان قرارداد `page`/`limit` مخزن روی گفتگو هم اعمال می‌شود.
 * ترتیب عمداً `createdAt asc` می‌ماند تا «صفحهٔ ۱» همان ابتدای گفتگو باشد و UI
 * بتواند بدون منطق تازه صفحه‌به‌صفحه جلو برود.
 *
 * ترتیبِ دو کوئری عمداً **متوالی** است، نه موازی: `count` فقط بعد از آن اجرا
 * می‌شود که مالکیت تأیید شده باشد. یعنی روی تیکتِ کاربرِ دیگر حتی یک
 * `count` هم به DB زده نمی‌شود (کاربرِ دیگر = داده نیست، حتی برای شمردن).
 *
 * کاربر عادی فقط تیکت خودش؛ staff هر تیکتی. `closedAt`/`status` که سرورکنترل‌شده
 * هستند از اینجا هم قابل‌خواندن‌اند ولی هرگز از ورودی نوشته نمی‌شوند.
 */
export async function getTicket(
    actor: TicketActor,
    ticketId: number,
    // `Partial` چون schema فاز T2 بعد از `.default()` هر دو فیلد را پر می‌کند؛
    // callerهای غیر-HTTP (و تست‌ها) می‌توانند بدون query هم صدا بزنند.
    query: Partial<TicketMessagePageQueryInput> = {},
): Promise<TicketDetailResult> {
    assertActor(actor)
    assertTicketId(ticketId)
    const where = isTicketStaff(actor) ? { id: ticketId } : { id: ticketId, userId: actor.id }

    const page = query.messagesPage ?? 1
    const limit = query.messagesLimit ?? TICKET_MESSAGE_DEFAULT_PAGE_SIZE

    const ticket = await getPrisma().ticket.findFirst({
        where,
        include: {
            messages: {
                // `id` به‌عنوان tiebreaker: دو پیام می‌توانند در یک میلی‌ثانیه
                // ساخته شوند و `createdAt` یکتا نیست. بدون ترتیبِ دوم، LIMIT/OFFSET
                // می‌تواند یک پیام را در دو صفحه تکرار کند یا از قلم بیندازد.
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                skip: (page - 1) * limit,
                take: limit,
            },
        },
    })
    if (!ticket) throw new TicketNotFoundError()

    const total = await getPrisma().ticketMessage.count({ where: { ticketId } })

    return { ticket, messagePage: { page, limit, total, hasMore: page * limit < total } }
}

/**
 * فهرست تیکت‌ها با pagination مخزن (`page`/`limit` + `hasMore`).
 *
 * دامنهٔ داده همان‌جایی بسته می‌شود که ownership enforce می‌شود:
 *   - کاربر: `userId = actor.id` (فیلتر اختیاری `status`)
 *   - staff: همهٔ کاربران (صف پشتیبانی؛ فیلتر اختیاری `status`)
 *
 * ترتیب از همان ایندکس‌های T1 می‌آید: کاربر «جدیدترین اول» (`createdAt desc`)،
 * staff «تازه‌به‌روزشده‌ها اول» (`updatedAt desc`).
 *
 * `id` نقش tiebreaker دارد (دقیقاً مثل `include.messages` در `getTicket`):
 * timestamp در دقت میلی‌ثانیه است، پس دو تیکت می‌توانند `createdAt`/`updatedAt`
 * یکسان داشته باشند. بدون ترتیب دوم، ترتیبِ برگشتیِ PostgreSQL تعریف‌نشده است و
 * `skip/take` می‌تواند یک تیکت را در دو صفحه تکرار کند یا از قلم بیندازد. اولویت
 * با `desc` حفظ می‌شود تا با ترتیب اصلی هیچ تغییری در رفتارِ «جدیدترین اول» نیفتد.
 */
export async function listTickets(
    actor: TicketActor,
    query: TicketListQueryInput,
): Promise<TicketListResult> {
    assertActor(actor)
    const page = query.page ?? 1
    const limit = query.limit ?? TICKET_DEFAULT_PAGE_SIZE
    const staff = isTicketStaff(actor)

    const where = {
        ...(staff ? {} : { userId: actor.id }),
        ...(query.status ? { status: query.status } : {}),
    }
    const orderBy = staff
        ? [{ updatedAt: "desc" as const }, { id: "desc" as const }]
        : [{ createdAt: "desc" as const }, { id: "desc" as const }]

    const [items, total] = await Promise.all([
        getPrisma().ticket.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
        getPrisma().ticket.count({ where }),
    ])

    return { items, page, limit, total, hasMore: page * limit < total }
}

/**
 * افزودن پیام + به‌روزرسانی اتمیکِ تیکت.
 *
 * ترتیب داخل تراکنش: ساخت پیام → CAS روی تیکت (`lastMessageAt` و گذار خودکارِ
 * وضعیت). اگر CAS شکست بخورد (وضعیت هم‌زمان عوض شده) خطا throw می‌شود و کل
 * تراکنش rollback می‌گردد؛ یعنی پیامِ یتیم روی تیکتی که وضعیتش عوض شده باقی
 * نمی‌ماند.
 */
export async function addTicketMessage(
    actor: TicketActor,
    ticketId: number,
    input: AddTicketMessageInput,
): Promise<TicketMessage> {
    const ticket = await resolveTicketForActor(actor, ticketId)
    if (ticket.status === "CLOSED") throw new TicketClosedError()

    const staff = isTicketStaff(actor)
    const nextStatus = resolveStatusAfterReply(ticket.status, staff)
    const now = new Date()

    return await getPrisma().$transaction(async (tx) => {
        const message = await tx.ticketMessage.create({
            data: {
                ticketId: ticket.id,
                authorUserId: actor.id,
                body: input.body,
                // snapshot نقش در لحظهٔ نوشتن (طبق توضیح مدل T1)
                isStaff: staff,
                createdAt: now,
            },
        })

        await casUpdateTicket(tx, ticket, {
            lastMessageAt: now,
            ...(nextStatus !== ticket.status ? { status: nextStatus } : {}),
        })

        return message
    })
}

/**
 * ویرایش تیکت.
 *
 * سیاست نقش‌محور (enforcement در service، نه route):
 *   - `status`  → **فقط staff**؛ کاربر عادی 403 می‌گیرد. گذارِ نامعتبر 409.
 *   - `priority`→ هر دو، ولی `URGENT` فقط staff (همان قاعدهٔ create).
 *   - `category`→ هر دو روی تیکتِ قابل‌دسترس (null = پاک‌کردن).
 *
 * `closedAt` هرگز از ورودی نمی‌آید: فقط وقتی status **واقعاً** به `CLOSED` می‌رود
 * با `new Date()` سمت سرور ست می‌شود، و چون `CLOSED` پایانی است هیچ‌وقت پاک نمی‌شود.
 */
export async function updateTicket(
    actor: TicketActor,
    ticketId: number,
    input: UpdateTicketInput,
): Promise<Ticket> {
    const ticket = await resolveTicketForActor(actor, ticketId)
    const staff = isTicketStaff(actor)

    if (input.status === undefined && input.priority === undefined && input.category === undefined) {
        throw new TicketNoChangesError(TICKET_NO_CHANGES_MESSAGE)
    }

    const patch: Prisma.TicketUncheckedUpdateInput = {}

    if (input.status !== undefined) {
        if (!staff) throw new TicketForbiddenError()
        assertTicketStatusTransition(ticket.status, input.status)
        patch.status = input.status
        if (input.status === "CLOSED" && ticket.closedAt == null) {
            patch.closedAt = new Date()
        }
    }

    if (input.priority !== undefined) {
        assertPriorityWritable(actor, input.priority)
        patch.priority = input.priority
    }

    if (input.category !== undefined) {
        assertCategoryWritable(input.category)
        patch.category = input.category
    }

    return await getPrisma().$transaction(async (tx) => casUpdateTicket(tx, ticket, patch))
}
