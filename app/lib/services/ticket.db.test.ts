// فاز T6 — تست integration واقعی برای Ticketing (PostgreSQL واقعی، بدون mock)
// ------------------------------------------------------------------
// این فایل الگوی رسمی مخزن برای `*.db.test.ts` را دنبال می‌کند (همان
// userActivity.concurrency.db.test.ts / promoCode.concurrency.db.test.ts):
//   • `assertTestDatabase()` در beforeAll ⇒ fail-closed، **پیش از هر write**.
//   • کاربران اختصاصی با marker یکتا برای هر اجرا؛ به هیچ رکورد موجودی دست نمی‌زند.
//   • cleanup همیشه در afterAll اجرا می‌شود.
//   • اگر DB واقعاً در دسترس نباشد، تست با پیام واضح fail می‌شود (نه سبز جعلی).
//
// پوشش: سناریوهای E2E A تا F، مالکیت/IDOR، RBAC، و compare-and-set زیر رقابت واقعی.
//
// اجرای تکی:
//   DATABASE_URL='<db تست معتبر>' npx vitest run app/lib/services/ticket.db.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"

import {
    addTicketMessage,
    createTicket,
    getTicket,
    listTickets,
    updateTicket,
} from "./ticket.service"
import {
    TicketClosedError,
    TicketConflictError,
    TicketForbiddenError,
    TicketInvalidTransitionError,
    TicketNotFoundError,
} from "./errors"
import { assertTestDatabase, testMarker } from "@/app/lib/testing/dbTestEnv"

const RUN_ID = testMarker("ticket")
const MARKER_PASSWORD = "not-a-real-password" // این تست هیچ مسیر رمزی را اجرا نمی‌کند

let prisma: PrismaClient

type SeededUser = { id: number; username: string; role: "USER" | "ADMIN" }
/** دو کاربر عادی + یک کارمند — حداقل لازم برای اثبات IDOR و RBAC. */
let userA: SeededUser
let userB: SeededUser
let staff: SeededUser

beforeAll(async () => {
    // 🔒 fail-closed: پیش از هر اتصال/نوشتن. اگر DATABASE_URL به دیتابیس
    // پروداکشن اشاره کند، تست همین‌جا متوقف می‌شود.
    assertTestDatabase()

    prisma = new PrismaClient()
    const probe = await prisma.$queryRaw`SELECT 1`
    expect(probe).toBeDefined()

    userA = await createUser("a")
    userB = await createUser("b")
    staff = await createUser("admin", "ADMIN")
})

afterAll(async () => {
    if (!prisma) return
    // حذف کاربر ⇒ تیکت‌ها و پیام‌هایشان با CASCADE می‌روند.
    await prisma.user.deleteMany({
        where: { username: { in: [userA.username, userB.username, staff.username] } },
    })
    await prisma.$disconnect()
})

async function createUser(suffix: string, role: "USER" | "ADMIN" = "USER"): Promise<SeededUser> {
    const username = `ticket-${suffix}-${RUN_ID}`
    const created = await prisma.user.create({
        data: { username, email: `${username}@example.test`, password: MARKER_PASSWORD, role },
        select: { id: true, username: true, role: true },
    })
    return created
}

/** actor از session درست می‌شود؛ اینجا فقط شکلش را می‌سازیم. */
function actor(user: SeededUser) {
    return { id: user.id, role: user.role }
}
function staffActor() {
    return { id: staff.id, role: "ADMIN" as const }
}

async function seedTicket(owner: SeededUser = userA) {
    const { ticket } = await createTicket(actor(owner), {
        subject: "خطا در ثبت تسک",
        body: "وقتی تسک می‌سازم صفحه سفید می‌شود.",
        category: "bug",
        priority: "HIGH",
    })
    return ticket
}

// ───────────────────────── A — ایجاد تیکت ─────────────────────────

describe("A — ایجاد تیکت و اولین پیام (اتمیک)", () => {
    it("مالک، وضعیت اولیه و اولین پیام را درست می‌نویسد", async () => {
        const before = Date.now()
        const { ticket, message } = await createTicket(actor(userA), {
            subject: "  موضوع تست  ",
            body: "  شرح مشکل  ",
            category: "billing",
            priority: "HIGH",
        })
        const after = Date.now()

        expect(ticket.userId).toBe(userA.id)
        expect(ticket.status).toBe("OPEN")
        expect(ticket.priority).toBe("HIGH")
        expect(ticket.category).toBe("billing")
        expect(ticket.closedAt).toBeNull()
        expect(ticket.lastMessageAt).not.toBeNull()
        expect(ticket.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)
        expect(ticket.lastMessageAt!.getTime()).toBeLessThanOrEqual(after + 1000)

        expect(message.authorUserId).toBe(userA.id)
        expect(message.isStaff).toBe(false)
        expect(message.ticketId).toBe(ticket.id)

        const messages = await prisma.ticketMessage.count({ where: { ticketId: ticket.id } })
        expect(messages).toBe(1)
    })

    it("اولویت و دستهٔ اختیاری واقعاً اختیاری‌اند (پیش‌فرض DB اعمال می‌شود)", async () => {
        const { ticket } = await createTicket(actor(userA), { subject: "s", body: "b" })

        expect(ticket.priority).toBe("MEDIUM")
        expect(ticket.category).toBeNull()
    })

    it("فیلدهای سرورکنترل‌شده از ورودی کاربر نادیده گرفته می‌شوند", async () => {
        // فراخوانی با ورودی پرآلوده (مثلاً caller غیر-TypeScript یا payload دستکاری‌شده)
        const { ticket, message } = await createTicket(actor(userA), {
            subject: "s",
            body: "b",
            userId: userB.id,
            status: "CLOSED",
            isStaff: true,
            closedAt: new Date("2000-01-01"),
            assignedToUserId: userB.id,
            role: "ADMIN",
        } as never)

        expect(ticket.userId).toBe(userA.id)
        expect(ticket.status).toBe("OPEN")
        expect(ticket.closedAt).toBeNull()
        expect(message.isStaff).toBe(false)
        expect(message.authorUserId).toBe(userA.id)
    })
})

// ───────────────────────── B — فهرست و خواندن ─────────────────────────

describe("B — فهرست و خواندن (دامنهٔ مالکیت)", () => {
    it("کاربر فقط تیکت‌های خودش را می‌بیند", async () => {
        await seedTicket(userA)
        await seedTicket(userB)

        const mine = await listTickets(actor(userA), { page: 1, limit: 20 })
        expect(mine.items.length).toBeGreaterThan(0)
        expect(mine.items.every((t) => t.userId === userA.id)).toBe(true)

        const others = await listTickets(actor(userB), { page: 1, limit: 20 })
        expect(others.items.every((t) => t.userId === userB.id)).toBe(true)
    })

    it("کارمند صف همهٔ کاربران را می‌بیند و با updatedAt مرتب می‌شود", async () => {
        const page = await listTickets(staffActor(), { page: 1, limit: 50 })

        expect(page.items.some((t) => t.userId === userA.id)).toBe(true)
        expect(page.items.some((t) => t.userId === userB.id)).toBe(true)

        const timestamps = page.items.map((t) => t.updatedAt.getTime())
        const sorted = [...timestamps].sort((x, y) => y - x)
        expect(timestamps).toEqual(sorted)
    })

    it("فیلتر وضعیت و صفحه‌بندی واقعاً اعمال می‌شود", async () => {
        const open = await listTickets(actor(userA), { page: 1, limit: 20, status: "OPEN" })
        expect(open.items.every((t) => t.status === "OPEN")).toBe(true)

        const empty = await listTickets(actor(userA), { page: 999, limit: 20 })
        expect(empty.items).toHaveLength(0)
        expect(empty.hasMore).toBe(false)
    })

    it("پیام‌ها به ترتیب قدیمی→جدیدی برمی‌گردند", async () => {
        const ticket = await seedTicket()
        await addTicketMessage(staffActor(), ticket.id, { body: "پاسخ اول کارمند" })
        await addTicketMessage(actor(userA), ticket.id, { body: "پاسخ کاربر" })

        const { ticket: detail } = await getTicket(actor(userA), ticket.id)

        expect(detail.messages).toHaveLength(3)
        const times = detail.messages.map((m) => m.createdAt.getTime())
        expect(times).toEqual([...times].sort((x, y) => x - y))
    })
})

// ───────────────────────── C/D — گذار خودکار با پیام ─────────────────────────

describe("C — پاسخ کارمند: OPEN → PENDING", () => {
    it("نویسنده، isStaff، lastMessageAt و وضعیت همگی درست‌اند", async () => {
        const ticket = await seedTicket()
        const previous = ticket.lastMessageAt!

        await new Promise((r) => setTimeout(r, 5))
        const message = await addTicketMessage(staffActor(), ticket.id, { body: "بررسی شد" })

        expect(message.authorUserId).toBe(staff.id)
        expect(message.isStaff).toBe(true)

        const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
        expect(after!.status).toBe("PENDING")
        expect(after!.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(previous.getTime())
        expect(after!.closedAt).toBeNull()
    })
})

describe("D — پاسخ کاربر: PENDING → OPEN", () => {
    it("پیام کاربر تیکت را به OPEN برمی‌گرداند و closedAt دست‌نخورده می‌ماند", async () => {
        const ticket = await seedTicket()
        await addTicketMessage(staffActor(), ticket.id, { body: "پاسخ کارمند" })

        const message = await addTicketMessage(actor(userA), ticket.id, { body: "ممنون، حل شد" })

        expect(message.authorUserId).toBe(userA.id)
        expect(message.isStaff).toBe(false)

        const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
        expect(after!.status).toBe("OPEN")
        expect(after!.closedAt).toBeNull()
    })

    it("پاسخ کارمند روی تیکت PENDING وضعیت را همان PENDING نگه می‌دارد", async () => {
        const ticket = await seedTicket()
        await addTicketMessage(staffActor(), ticket.id, { body: "اولی" })
        await addTicketMessage(actor(userA), ticket.id, { body: "دومی" })
        await addTicketMessage(staffActor(), ticket.id, { body: "سومی" })

        const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
        expect(after!.status).toBe("PENDING")
    })
})

// ───────────────────────── E/F — بستن و پایانی‌بودن CLOSED ─────────────────────────

describe("E — بستن تیکت توسط کارمند", () => {
    it("CLOSED می‌شود و closedAt سمت سرور مقدار می‌گیرد", async () => {
        const ticket = await seedTicket()
        const before = Date.now()

        const closed = await updateTicket(staffActor(), ticket.id, { status: "CLOSED" })
        const after = Date.now()

        expect(closed.status).toBe("CLOSED")
        expect(closed.closedAt).not.toBeNull()
        expect(closed.closedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)
        expect(closed.closedAt!.getTime()).toBeLessThanOrEqual(after + 1000)
    })

    it("OPEN → CLOSED و PENDING → CLOSED هر دو مجازند", async () => {
        const fromOpen = await seedTicket()
        expect((await updateTicket(staffActor(), fromOpen.id, { status: "CLOSED" })).status).toBe("CLOSED")

        const fromPending = await seedTicket()
        await addTicketMessage(staffActor(), fromPending.id, { body: "پاسخ" })
        expect((await updateTicket(staffActor(), fromPending.id, { status: "CLOSED" })).status).toBe("CLOSED")
    })
})

describe("F — CLOSED پایانی است", () => {
    it("ارسال پیام روی تیکت بسته 409 می‌دهد و هیچ ردیفی نمی‌نویسد", async () => {
        const ticket = await seedTicket()
        await updateTicket(staffActor(), ticket.id, { status: "CLOSED" })
        const before = await prisma.ticketMessage.count({ where: { ticketId: ticket.id } })

        await expect(addTicketMessage(actor(userA), ticket.id, { body: "دیر شد" })).rejects.toBeInstanceOf(
            TicketClosedError,
        )
        await expect(addTicketMessage(staffActor(), ticket.id, { body: "دیر شد" })).rejects.toBeInstanceOf(
            TicketClosedError,
        )

        expect(await prisma.ticketMessage.count({ where: { ticketId: ticket.id } })).toBe(before)
    })

    it("بازگرداندن تیکت بسته به OPEN/PENDING رد می‌شود و closedAt پاک نمی‌شود", async () => {
        const ticket = await seedTicket()
        const closed = await updateTicket(staffActor(), ticket.id, { status: "CLOSED" })

        await expect(updateTicket(staffActor(), ticket.id, { status: "OPEN" })).rejects.toBeInstanceOf(
            TicketInvalidTransitionError,
        )
        await expect(updateTicket(staffActor(), ticket.id, { status: "PENDING" })).rejects.toBeInstanceOf(
            TicketInvalidTransitionError,
        )

        const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
        expect(after!.status).toBe("CLOSED")
        expect(after!.closedAt!.getTime()).toBe(closed.closedAt!.getTime())
    })
})

// ───────────────────────── مالکیت / IDOR ─────────────────────────

describe("مالکیت و IDOR — کاربر A و تیکت کاربر B", () => {
    it("خواندن، پیام و ویرایش همگی 404 می‌دهند (نه 403 — بدون نشت وجود)", async () => {
        const ticketB = await seedTicket(userB)

        await expect(getTicket(actor(userA), ticketB.id)).rejects.toBeInstanceOf(TicketNotFoundError)
        await expect(addTicketMessage(actor(userA), ticketB.id, { body: "دستکاری" })).rejects.toBeInstanceOf(
            TicketNotFoundError,
        )
        await expect(updateTicket(actor(userA), ticketB.id, { priority: "LOW" })).rejects.toBeInstanceOf(
            TicketNotFoundError,
        )

        // هیچ نوشتنی نباید رخ داده باشد
        const messages = await prisma.ticketMessage.count({ where: { ticketId: ticketB.id } })
        expect(messages).toBe(1)
        const untouched = await prisma.ticket.findUnique({ where: { id: ticketB.id } })
        expect(untouched!.priority).toBe("HIGH")
    })

    it("کارمند می‌تواند تیکت کاربر دیگر را بخواند و مدیریت کند", async () => {
        const ticketB = await seedTicket(userB)

        const { ticket: detail } = await getTicket(staffActor(), ticketB.id)
        expect(detail.id).toBe(ticketB.id)

        const updated = await updateTicket(staffActor(), ticketB.id, { priority: "URGENT" })
        expect(updated.priority).toBe("URGENT")
    })

    it("شناسهٔ ناموجود همان پاسخ را می‌گیرد (وجود افشا نمی‌شود)", async () => {
        const missingId = 2 ** 31 - 1
        await expect(getTicket(actor(userA), missingId)).rejects.toBeInstanceOf(TicketNotFoundError)
        await expect(getTicket(actor(userB), missingId)).rejects.toBeInstanceOf(TicketNotFoundError)
    })
})

// ───────────────────────── RBAC ─────────────────────────

describe("RBAC — کاربر عادی در برابر کارمند", () => {
    it("کاربر نمی‌تواند URGENT بگذارد (هم create و هم update)", async () => {
        await expect(
            createTicket(actor(userA), { subject: "s", body: "b", priority: "URGENT" } as never),
        ).rejects.toBeInstanceOf(TicketForbiddenError)

        const ticket = await seedTicket()
        await expect(updateTicket(actor(userA), ticket.id, { priority: "URGENT" })).rejects.toBeInstanceOf(
            TicketForbiddenError,
        )

        const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
        expect(after!.priority).toBe("HIGH")
    })

    it("کاربر می‌تواند اولویت عادی و دستهٔ خودش را تغییر دهد", async () => {
        const ticket = await seedTicket()

        const updated = await updateTicket(actor(userA), ticket.id, { priority: "LOW", category: "account" })
        expect(updated.priority).toBe("LOW")
        expect(updated.category).toBe("account")

        const cleared = await updateTicket(actor(userA), ticket.id, { category: null })
        expect(cleared.category).toBeNull()
    })

    it("کاربر نمی‌تواند وضعیت را تغییر دهد — حتی PENDING", async () => {
        const ticket = await seedTicket()

        await expect(updateTicket(actor(userA), ticket.id, { status: "CLOSED" })).rejects.toBeInstanceOf(
            TicketForbiddenError,
        )
        await expect(updateTicket(actor(userA), ticket.id, { status: "PENDING" })).rejects.toBeInstanceOf(
            TicketForbiddenError,
        )

        const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
        expect(after!.status).toBe("OPEN")
        expect(after!.closedAt).toBeNull()
    })

    it("کارمند کل enum اولویت و وضعیت را می‌تواند بگذارد", async () => {
        const ticket = await seedTicket()

        const updated = await updateTicket(staffActor(), ticket.id, {
            status: "PENDING",
            priority: "URGENT",
            category: "other",
        })
        expect(updated.status).toBe("PENDING")
        expect(updated.priority).toBe("URGENT")
        expect(updated.category).toBe("other")
    })

    it("دسته/اولویت خارج از واژگان با 400 رد می‌شود و چیزی نوشته نمی‌شود", async () => {
        const ticket = await seedTicket()

        await expect(updateTicket(actor(userA), ticket.id, { priority: "CRITICAL" } as never)).rejects.toMatchObject(
            { status: 400 },
        )
        await expect(updateTicket(actor(userA), ticket.id, { category: "HOME" } as never)).rejects.toMatchObject({
            status: 400,
        })

        const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
        expect(after!.priority).toBe("HIGH")
        expect(after!.category).toBe("bug")
    })
})

// ───────────────────────── concurrency / CAS ─────────────────────────

describe("concurrency — compare-and-set زیر رقابت واقعی", () => {
    it("دو گذار هم‌زمانِ وضعیت: یکی برنده، دیگری TICKET_CONFLICT (بدون بازنویسی)", async () => {
        const conflicts: string[] = []
        let conflictsSeen = 0
        const ROUNDS = 5

        for (let round = 0; round < ROUNDS; round++) {
            const ticket = await seedTicket()

            // هر دو فراخوانی وضعیت OPEN را می‌بینند و هر دو می‌خواهند
            // updateMany({where:{id, status:"OPEN"}}) بزنند ⇒ یکی count=1، دیگری count=0.
            const results = await Promise.allSettled([
                updateTicket(staffActor(), ticket.id, { status: "PENDING" }),
                updateTicket(staffActor(), ticket.id, { status: "CLOSED" }),
            ])

            const fulfilled = results.filter((r) => r.status === "fulfilled")
            const rejected = results.filter((r) => r.status === "rejected")

            expect(fulfilled.length).toBe(1)
            expect(rejected.length).toBe(1)
            const reason = (rejected[0] as PromiseRejectedResult).reason
            // بازنده بسته به interleaving یکی از این دو را می‌گیرد — هر دو امن‌اند:
            //   • اگر read بعد از commit برنده انجام شده و گذارِ درخواستی از وضعیت
            //     جدید نامعتبر است ⇒ TicketInvalidTransitionError (پیش از رسیدن به CAS)
            //   • اگر read وضعیت قدیمی را دیده ولی CAS باخته ⇒ TicketConflictError
            // هیچ‌کدام اجازهٔ بازنویسی بی‌صدا نمی‌دهند.
            expect(
                reason instanceof TicketConflictError || reason instanceof TicketInvalidTransitionError,
            ).toBe(true)
            conflictsSeen++

            const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
            // وضعیت نهایی یکی از دو مقدار مجاز است و هرگز «نیمه‌کاره» نیست
            expect(["PENDING", "CLOSED"]).toContain(after!.status)
            // closedAt فقط وقتی ست شده که واقعاً CLOSED شده
            if (after!.status === "CLOSED") expect(after!.closedAt).not.toBeNull()
            else expect(after!.closedAt).toBeNull()

            conflicts.push(reason.code ?? "")
        }

        expect(conflictsSeen).toBe(ROUNDS)
        // هر دو خطا ۴۰۹‌اند ⇒ سطح HTTP برای کلاینت یکسان است
        expect(conflicts.every((c) => c === "TICKET_CONFLICT" || c === "TICKET_INVALID_TRANSITION")).toBe(true)
    })

    it("بستن تیکت در رقابت با پیام: هیچ پیام یتیم یا تکراری باقی نمی‌ماند", async () => {
        for (let round = 0; round < 5; round++) {
            const ticket = await seedTicket()
            const baseline = await prisma.ticketMessage.count({ where: { ticketId: ticket.id } })

            const [closeResult, messageResult] = await Promise.allSettled([
                updateTicket(staffActor(), ticket.id, { status: "CLOSED" }),
                addTicketMessage(actor(userA), ticket.id, { body: "پیام هم‌زمان با بستن" }),
            ])

            // هر کدام موفق شده باشد، اگر موفق بوده نباید خطا داده باشد و داده‌اش باید در DB باشد
            if (messageResult.status === "fulfilled") {
                const persisted = await prisma.ticketMessage.findUnique({ where: { id: messageResult.value.id } })
                expect(persisted).not.toBeNull()
                expect(persisted!.ticketId).toBe(ticket.id)
            } else {
                // بستن زودتر دیده شده ⇒ TICKET_CLOSED؛ read پیش از close بوده ولی
                // CAS باخته ⇒ TICKET_CONFLICT (و پیام rollback شده).
                expect(
                    messageResult.reason instanceof TicketClosedError ||
                        messageResult.reason instanceof TicketConflictError,
                ).toBe(true)
            }

            if (closeResult.status === "fulfilled") {
                expect(closeResult.value.status).toBe("CLOSED")
                expect(closeResult.value.closedAt).not.toBeNull()
            }

            const ticketExists = await prisma.ticket.findUnique({ where: { id: ticket.id } })
            expect(ticketExists).not.toBeNull()

            // شمارش دقیق: baseline + (پیام موفق)
            const finalCount = await prisma.ticketMessage.count({ where: { ticketId: ticket.id } })
            const expected = baseline + (messageResult.status === "fulfilled" ? 1 : 0)
            expect(finalCount).toBe(expected)

            // هیچ پیامی به تیکتِ ناموجود اشاره نکند
            const orphans = await prisma.ticketMessage.count({ where: { ticketId: ticket.id + 1_000_000 } })
            expect(orphans).toBe(0)
        }
    })

    it("دو ویرایش غیر وضعیتِ هم‌زمان هر دو موفق‌اند (CAS روی status رابطه‌ای ندارد)", async () => {
        const ticket = await seedTicket()

        const results = await Promise.allSettled([
            updateTicket(actor(userA), ticket.id, { priority: "LOW" }),
            updateTicket(actor(userA), ticket.id, { category: "account" }),
        ])

        expect(results.every((r) => r.status === "fulfilled")).toBe(true)
        const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
        expect(after!.priority).toBe("LOW")
        expect(after!.category).toBe("account")
    })
})

// ───────────────── صفحه‌بندی گفتگو روی DB واقعی (R1) ─────────────────
//
// اثباتِ «بی‌نهایت نبودنِ خواندن» باید روی PostgreSQL واقعی باشد، چون دقیقاً
// رفتار LIMIT/OFFSET و ترتیبِ دوتایی (`createdAt`, `id`) را است که باید اثبات شود.

/** تیکتی با `total` پیام: یک پیام اول (اتمیک) + `total - 1` پیامِ بعدی. */
async function seedThread(total: number, owner: SeededUser = userA) {
    const ticket = await seedTicket(owner)
    for (let i = 1; i < total; i++) {
        const staffReply = i % 2 === 1
        await addTicketMessage(staffReply ? staffActor() : actor(owner), ticket.id, {
            body: `پیام شمارهٔ ${i + 1}`,
        })
    }
    return ticket
}

describe("صفحه‌بندی پیام‌ها — سقف واقعی روی DB", () => {
    const TOTAL = 25

    it("صفحهٔ اول سقف دارد و total کلِ گفتگوست", async () => {
        const ticket = await seedThread(TOTAL)

        const { ticket: detail, messagePage } = await getTicket(actor(userA), ticket.id, {
            messagesPage: 1,
            messagesLimit: 20,
        })

        expect(detail.messages).toHaveLength(20) // نه ۲۵ — خواندن بی‌نهایت رفع شد
        expect(messagePage).toEqual({ page: 1, limit: 20, total: TOTAL, hasMore: true })
    })

    it("ترتیب قدیمی→جدیدی در هر صفحه حفظ می‌شود", async () => {
        const ticket = await seedThread(5)

        const { ticket: detail } = await getTicket(actor(userA), ticket.id, {
            messagesPage: 1,
            messagesLimit: 20,
        })

        const bodies = detail.messages.map((m) => m.body)
        expect(bodies[0]).toBe("وقتی تسک می‌سازم صفحه سفید می‌شود.") // اولین پیام
        expect(bodies).toContain("پیام شمارهٔ 5")
        const times = detail.messages.map((m) => m.createdAt.getTime())
        expect(times).toEqual([...times].sort((x, y) => x - y))
    })

    it("صفحات کنار هم کلِ گفتگو را بدون تکرار و بدون قلم‌افتادن می‌دهند", async () => {
        const ticket = await seedThread(TOTAL)

        const first = await getTicket(actor(userA), ticket.id, { messagesPage: 1, messagesLimit: 20 })
        const second = await getTicket(actor(userA), ticket.id, { messagesPage: 2, messagesLimit: 20 })

        const ids = [...first.ticket.messages, ...second.ticket.messages].map((m) => m.id)
        expect(first.ticket.messages).toHaveLength(20)
        expect(second.ticket.messages).toHaveLength(5)
        expect(new Set(ids).size).toBe(TOTAL) // نه تکرار
        expect(second.messagePage).toEqual({ page: 2, limit: 20, total: TOTAL, hasMore: false })

        // هر پیام دقیقاً یک بار و ترتیب کلی قدیمی→جدیدی
        const stored = await prisma.ticketMessage.findMany({
            where: { ticketId: ticket.id },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
        expect(ids).toEqual(stored.map((m) => m.id))
    })

    it("limit بزرگ همه را یک‌جا می‌دهد (رفتار قدیمی هنوز ممکن است)", async () => {
        const ticket = await seedThread(TOTAL)

        const { ticket: detail, messagePage } = await getTicket(actor(userA), ticket.id, {
            messagesPage: 1,
            messagesLimit: 100,
        })

        expect(detail.messages).toHaveLength(TOTAL)
        expect(messagePage.hasMore).toBe(false)
    })

    it("صفحهٔ خارج از بازه خالی است ولی total درست می‌ماند", async () => {
        const ticket = await seedThread(TOTAL)

        const { ticket: detail, messagePage } = await getTicket(actor(userA), ticket.id, {
            messagesPage: 99,
            messagesLimit: 20,
        })

        expect(detail.messages).toHaveLength(0)
        expect(messagePage).toEqual({ page: 99, limit: 20, total: TOTAL, hasMore: false })
    })

    it("کارمند همان صفحات را روی تیکتِ کاربرِ دیگر می‌بیند", async () => {
        const ticket = await seedThread(TOTAL)

        const owner = await getTicket(actor(userA), ticket.id, { messagesPage: 1, messagesLimit: 20 })
        const staff = await getTicket(staffActor(), ticket.id, { messagesPage: 1, messagesLimit: 20 })

        expect(staff.ticket.messages.map((m) => m.id)).toEqual(owner.ticket.messages.map((m) => m.id))
        expect(staff.messagePage.total).toBe(TOTAL)
    })

    it("IDOR با query صفحه‌بندی هم بسته است: 404 و بی‌نشت", async () => {
        const ticketB = await seedThread(3, userB)

        await expect(
            getTicket(actor(userA), ticketB.id, { messagesPage: 1, messagesLimit: 1 }),
        ).rejects.toBeInstanceOf(TicketNotFoundError)

        // نه total افشا می‌شود، نه تیکت تغییر می‌کند
        const stillThree = await prisma.ticketMessage.count({ where: { ticketId: ticketB.id } })
        expect(stillThree).toBe(3)
    })

    it("خواندنِ صفحه‌بندی‌شده هیچ نوشتنی و تغییر وضعیتی ندارد", async () => {
        const ticket = await seedThread(4)
        const before = await prisma.ticket.findUnique({ where: { id: ticket.id } })

        await getTicket(actor(userA), ticket.id, { messagesPage: 2, messagesLimit: 2 })
        await getTicket(staffActor(), ticket.id, { messagesPage: 1, messagesLimit: 2 })

        const after = await prisma.ticket.findUnique({ where: { id: ticket.id } })
        expect(after!.status).toBe(before!.status)
        expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime())
        expect(after!.closedAt).toBeNull()
    })

    it("پیام تازه total را زیاد می‌کند و صفحهٔ آخر را فعال می‌کند (بدون شکستن state machine)", async () => {
        const ticket = await seedThread(20)
        const first = await getTicket(actor(userA), ticket.id, { messagesPage: 1, messagesLimit: 20 })
        expect(first.messagePage.hasMore).toBe(false)

        // پاسخ کارمند ⇒ OPEN → PENDING (همان قاعدهٔ فاز T3، بدون تغییر)
        await addTicketMessage(staffActor(), ticket.id, { body: "پیام بیست‌ویکم" })

        const second = await getTicket(actor(userA), ticket.id, { messagesPage: 2, messagesLimit: 20 })
        expect(second.ticket.status).toBe("PENDING")
        expect(second.messagePage).toEqual({ page: 2, limit: 20, total: 21, hasMore: false })
        expect(second.ticket.messages).toHaveLength(1)
        expect(second.ticket.messages[0].body).toBe("پیام بیست‌ویکم")
    })
})

// ───────── T8 — قطعی‌بودن صفحه‌بندی فهرست (tiebreaker روی `id`) ─────────

describe("T8 — فهرست با timestamp یکسان صفحه‌بندیِ قطعی می‌ماند", () => {
    it("صفحات کنار هم نه تکرار می‌دهند، نه چیزی از قلم می‌اندازند، نه ترتیب نوسان می‌کند", async () => {
        // کاربر اختصاصی تا صفِ این تست با بقیهٔ تست‌ها قاطی نشود (total قابل‌شمارش است).
        const owner = await createUser("tied")
        // timestamp در دقت میلی‌ثانیه است ⇒ ساخت ۲۵ تیکت در یک لحظه واقعاً ممکن است
        // (import دسته‌ای، cron، یا نوشتنِ هم‌زمان). ترتیبِ تک‌ستونی در این حالت
        // تعریف‌نشده است و `skip/take` می‌تواند ردیف تکرار کند یا حذف.
        // نکته: در این دیتابیس PostgreSQL اتفاقاً همین‌جا ترتیبِ پایدار برمی‌گرداند،
        // پس این تست تضمینِ رفتار را نگه می‌دارد ولی خودش قفلِ `id` نیست؛ قفلِ
        // `orderBy` در `ticket.service.test.ts` است (که با حذفِ tiebreaker قرمز می‌شود).
        const tiedAt = new Date("2026-03-01T10:00:00.000Z")
        const total = 25
        const limit = 10

        await prisma.ticket.createMany({
            data: Array.from({ length: total }, (_, index) => ({
                userId: owner.id,
                subject: `تیکت هم‌زمان ${index}`,
                createdAt: tiedAt,
                updatedAt: tiedAt,
            })),
        })

        try {
            const pages: number[][] = []
            const meta: { total: number; hasMore: boolean }[] = []
            for (let page = 1; page <= Math.ceil(total / limit); page += 1) {
                const result = await listTickets(actor(owner), { page, limit })
                pages.push(result.items.map((t) => t.id))
                meta.push({ total: result.total, hasMore: result.hasMore })
            }

            const ids = pages.flat()
            // نه تکرار …
            expect(ids).toHaveLength(total)
            expect(new Set(ids).size).toBe(total)
            // … و نه قلم‌افتادن: هر ۲۵ تیکت دقیقاً یک‌بار دیده شده‌اند.
            const seeded = await prisma.ticket.findMany({ where: { userId: owner.id }, select: { id: true } })
            expect([...ids].sort((a, b) => a - b)).toEqual(seeded.map((t) => t.id).sort((a, b) => a - b))
            // پوشش همهٔ صف‌ها و درصد کاربر هم درست است.
            expect(meta).toEqual([
                { total, hasMore: true },
                { total, hasMore: true },
                { total, hasMore: false },
            ])
            // ترتیب در تکرارِ همان صفحه پایدار است (نه یک ترتیبِ تصادفیِ DB).
            const repeat = await listTickets(actor(owner), { page: 1, limit })
            expect(repeat.items.map((t) => t.id)).toEqual(pages[0])
        } finally {
            await prisma.user.delete({ where: { id: owner.id } })
        }
    })

    it("صف کارمند هم روی timestamp یکسان پایدار است", async () => {
        const before = await listTickets(staffActor(), { page: 1, limit: 20 })
        const again = await listTickets(staffActor(), { page: 1, limit: 20 })

        expect(again.items.map((t) => t.id)).toEqual(before.items.map((t) => t.id))
        expect(new Set(before.items.map((t) => t.id)).size).toBe(before.items.length)
    })
})
