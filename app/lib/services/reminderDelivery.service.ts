import { getPrisma } from "@/app/lib/getPrisma"

// ADR-07 فاز ۳-B — primitives برای idempotency تحویل Reminder.
//
// claim با `create` روی کلید یکتای (taskId, subscriptionId, reminderAt) انجام می‌شود؛
// نقض unique (P2002) یعنی «قبلاً claim شده» → null برمی‌گردد و هیچ ارسال دوباره‌ای رخ نمی‌دهد.
// این کاملاً DB-safe است: دو scheduler هم‌زمان نمی‌توانند هر دو claim بگیرند.
//
// targeted note: این یک سیاست at-most-once برای هر (task, subscription, reminderAt) است؛
// شکست موقت (transient) ثبت می‌شود ولی به‌صورت خودکار retry نمی‌شود تا خطر ارسال تکراری نباشد.

const PRISMA_UNIQUE_VIOLATION = "P2002"
const PRISMA_RECORD_NOT_FOUND = "P2025"

export function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === PRISMA_UNIQUE_VIOLATION
    )
}

/**
 * race پس از حذف User/Task/Subscription: ردیف delivery با cascade رفته است و update
 * روی شناسه‌ی ناموجود P2025 می‌دهد. نیست.
 */
export function isRecordNotFound(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === PRISMA_RECORD_NOT_FOUND
    )
}

/**
 * به‌روزرسانی وضعیت یک delivery که در برابر race حذف (Task/Subscription/User در حین اجرا)
 * مقاوم است: اگر ردیف دیگر نباشد (cascade)، این یک no-op است، نه شکست ارسال.
 * این موضوع batch را نمی‌شکند و آمار `failed` را آلوده نمی‌کند.
 */
async function updateDeliveryStatus(
    id: string,
    data: { status: DeliveryStatus; sentAt?: Date; failureCode?: string },
): Promise<void> {
    try {
        await getPrisma().taskReminderDelivery.update({ where: { id }, data })
    } catch (error) {
        if (isRecordNotFound(error)) return
        throw error
    }
}

export type DeliveryStatus = "PENDING" | "SENT" | "FAILED" | "GONE"

export type DeliveryClaim = { id: string }

/**
 * claim اتمیک یک delivery. خروجی null = این (task, subscription, reminderAt) قبلاً claim شده.
 * خطاهای غیر از unique به caller پرتاب می‌شوند تا قابل ثبت/پیگیری باشند.
 */
export async function claimReminderDelivery(input: {
    taskId: number
    subscriptionId: string
    reminderAt: Date
}): Promise<DeliveryClaim | null> {
    try {
        const row = await getPrisma().taskReminderDelivery.create({
            data: {
                taskId: input.taskId,
                subscriptionId: input.subscriptionId,
                reminderAt: input.reminderAt,
                status: "PENDING",
                attempts: 1,
            },
            select: { id: true },
        })
        return { id: row.id }
    } catch (error) {
        if (isUniqueViolation(error)) return null
        throw error
    }
}

export async function markDeliverySent(id: string, now: Date = new Date()): Promise<void> {
    await updateDeliveryStatus(id, { status: "SENT", sentAt: now })
}

export async function markDeliveryFailed(id: string, failureCode: string): Promise<void> {
    await updateDeliveryStatus(id, { status: "FAILED", failureCode })
}

export async function markDeliveryGone(id: string, failureCode: string): Promise<void> {
    await updateDeliveryStatus(id, { status: "GONE", failureCode })
}
