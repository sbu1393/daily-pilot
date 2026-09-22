"use client"

/**
 * ADR-07 فاز ۴-A — تحویل یک یادآوری Task به کاربر (لایه‌ی قابل‌تست).
 * ---------------------------------------------------------------
 * چرا این ماژول وجود دارد:
 *   - `new Notification(...)` در تقریباً همه‌ی مرورگرهای موبایل TypeError می‌دهد
 *     (مستند MDN: باید از `ServiceWorkerRegistration.showNotification()` استفاده شود).
 *     بنابراین مسیر اعلان OS این‌جا **فقط** از registration سرویس‌ورکر می‌گذرد.
 *   - نتیجه‌ی تحویل باید صریح باشد تا caller بتواند طبق قاعده‌ی «فقط پس از نمایش
 *     موفق، کلید fired را ثبت کن» تصمیم بگیرد.
 *
 * رفتار:
 *   ۱) permission !== granted → بازخورد درون‌برنامه‌ای (toast) ⇒ shown: true / channel: toast
 *   ۲) سرویس‌ورکر/registration در دسترس نباشد → toast ⇒ shown: true / channel: toast
 *   ۳) `registration.showNotification` موفق → shown: true / channel: notification
 *   ۴) `registration.showNotification` خطا بدهد → shown: false / notification_failed
 *      (caller نباید کلید fired ثبت کند؛ خودش یک‌بار بازخورد جایگزین می‌دهد)
 *
 * این ماژول هیچ IndexedDB/زمان‌بندی/ارسال Push ندارد.
 */

export type ReminderDeliveryPermission = "granted" | "denied" | "default" | null | undefined

export type ReminderNotificationDeps = {
    /** `Notification.permission` (تزریق‌پذیر برای تست) */
    permission: () => ReminderDeliveryPermission
    /** `navigator.serviceWorker.ready` — `undefined` یعنی پشتیبانی نمی‌شود */
    serviceWorkerReady: () => Promise<unknown> | undefined
    /** بازخورد درون‌برنامه‌ای (toast) */
    showToast: (text: string) => void
}

export type ReminderMessage = {
    /** کلید ضدتکرار: `${taskId}@${reminderAt}` */
    key: string
    title: string
    body: string
    /** متن toast در حالت‌های جایگزین */
    toastText: string
    taskId?: number
    url?: string
}

export type ReminderDeliveryOutcome =
    | { shown: true; channel: "notification" | "toast" }
    | { shown: false; reason: "notification_failed" }

type RegistrationLike = {
    showNotification?: (title: string, options?: Record<string, unknown>) => Promise<void>
}

async function resolveRegistration(
    deps: ReminderNotificationDeps,
): Promise<RegistrationLike | null> {
    try {
        const pending = deps.serviceWorkerReady()
        if (!pending) return null
        return (await pending) as RegistrationLike
    } catch {
        // `serviceWorker.ready` می‌تواند reject کند (context ناامن/بدون SW فعال)
        return null
    }
}

/** تحویل یک یادآوری. هرگز throw نمی‌کند. */
export async function deliverTaskReminder(
    message: ReminderMessage,
    deps: ReminderNotificationDeps,
): Promise<ReminderDeliveryOutcome> {
    if (deps.permission() !== "granted") {
        deps.showToast(message.toastText)
        return { shown: true, channel: "toast" }
    }

    const registration = await resolveRegistration(deps)
    if (!registration || typeof registration.showNotification !== "function") {
        deps.showToast(message.toastText)
        return { shown: true, channel: "toast" }
    }

    const options: Record<string, unknown> = {
        body: message.body,
        tag: message.key,
    }
    if (message.taskId != null || message.url) {
        options.data = { taskId: message.taskId ?? null, url: message.url ?? null }
    }

    try {
        await registration.showNotification(message.title, options)
        return { shown: true, channel: "notification" }
    } catch {
        return { shown: false, reason: "notification_failed" }
    }
}

/** depهای واقعی مرورگر (تزریق‌پذیر از سمت کامپوننت). */
export function browserReminderDeliveryDeps(options?: {
    showToast?: (text: string) => void
}): ReminderNotificationDeps {
    return {
        permission: () =>
            typeof Notification === "undefined" ? null : Notification.permission,
        serviceWorkerReady: () => {
            if (typeof navigator === "undefined" || !navigator.serviceWorker) return undefined
            return navigator.serviceWorker.ready as Promise<unknown>
        },
        showToast: options?.showToast ?? (() => {}),
    }
}
