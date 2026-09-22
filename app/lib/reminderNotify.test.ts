import { describe, expect, it, vi } from "vitest"
import {
    browserReminderDeliveryDeps,
    deliverTaskReminder,
    type ReminderMessage,
    type ReminderNotificationDeps,
} from "./reminderNotify"

/* ------------------------------------------------------------------ */
/* ADR-07 فاز ۴-A — تحویل یادآوری.                                     */
/* محیط node بدون DOM: depهای مرورگر تزریق می‌شوند.                      */
/* ------------------------------------------------------------------ */

const MESSAGE: ReminderMessage = {
    key: "42@2026-09-22T09:30:00.000Z",
    taskId: 42,
    title: "یادآور روزساز",
    body: "«تماس با مشتری» — یادآوری ساعت ۱۴:۳۰",
    url: "/dashboard?taskId=42",
    toastText: "⏰ «تماس با مشتری» — یادآوری ساعت ۱۴:۳۰",
}

function deps(overrides: Partial<ReminderNotificationDeps> = {}) {
    return {
        permission: () => "granted" as const,
        serviceWorkerReady: () => Promise.resolve({ showNotification: vi.fn().mockResolvedValue(undefined) }),
        showToast: vi.fn(),
        ...overrides,
    } satisfies ReminderNotificationDeps
}

/** registration حداقلی با پیگیری فراخوانی showNotification */
function makeRegistration(outcome: "ok" | "throw") {
    const showNotification = vi.fn(async () => {
        if (outcome === "throw") throw new TypeError("showNotification failed")
    })
    return { registration: { showNotification }, showNotification }
}

describe("deliverTaskReminder — notification path", () => {
    it("uses registration.showNotification (never the page Notification constructor)", async () => {
        const { registration, showNotification } = makeRegistration("ok")
        const d = deps({ serviceWorkerReady: () => Promise.resolve(registration) })

        const result = await deliverTaskReminder(MESSAGE, d)

        expect(result).toEqual({ shown: true, channel: "notification" })
        expect(showNotification).toHaveBeenCalledTimes(1)
        const [title, options] = showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>]
        expect(title).toBe(MESSAGE.title)
        expect(options.body).toBe(MESSAGE.body)
        expect(options.tag).toBe(MESSAGE.key)
        expect(options.data).toEqual({ taskId: 42, url: "/dashboard?taskId=42" })
        expect(d.showToast).not.toHaveBeenCalled()
    })

    it("omits the data payload when no taskId/url is provided", async () => {
        const { registration, showNotification } = makeRegistration("ok")
        const d = deps({ serviceWorkerReady: () => Promise.resolve(registration) })

        await deliverTaskReminder({ key: "1@t", title: "t", body: "b", toastText: "x" }, d)

        const [, options] = showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>]
        expect(options.data).toBeUndefined()
    })

    it("reports failure (and does NOT fall back to a toast) when showNotification throws", async () => {
        const { registration } = makeRegistration("throw")
        const d = deps({ serviceWorkerReady: () => Promise.resolve(registration) })

        const result = await deliverTaskReminder(MESSAGE, d)

        expect(result).toEqual({ shown: false, reason: "notification_failed" })
        expect(d.showToast).not.toHaveBeenCalled()
    })

    it("never throws when the registration API is unexpectedly missing or broken", async () => {
        const cases: (() => Promise<unknown> | undefined)[] = [
            () => undefined,
            () => Promise.resolve({}),
            () => Promise.resolve({ showNotification: "not-a-function" }),
            () => Promise.reject(new Error("no active service worker")),
        ]

        for (const serviceWorkerReady of cases) {
            const d = deps({ serviceWorkerReady })
            const result = await deliverTaskReminder(MESSAGE, d)

            expect(result).toEqual({ shown: true, channel: "toast" })
            expect(d.showToast).toHaveBeenCalledWith(MESSAGE.toastText)
        }
    })
})

describe("deliverTaskReminder — permission path", () => {
    it.each([["denied"], ["default"], [null], [undefined]] as const)(
        "falls back to in-app toast when permission is %s",
        async (permission) => {
            const { showNotification } = makeRegistration("ok")
            const d = deps({
                permission: () => permission,
                serviceWorkerReady: () => {
                    throw new Error("must not be called when permission is not granted")
                },
            })

            const result = await deliverTaskReminder(MESSAGE, d)

            expect(result).toEqual({ shown: true, channel: "toast" })
            expect(d.showToast).toHaveBeenCalledWith(MESSAGE.toastText)
            expect(showNotification).not.toHaveBeenCalled()
        },
    )
})

describe("browserReminderDeliveryDeps", () => {
    it("reports no permission and no service worker in a non-browser environment", () => {
        const d = browserReminderDeliveryDeps()

        expect(d.permission()).toBeNull()
        expect(d.serviceWorkerReady()).toBeUndefined()
    })

    it("routes the toast text to the injected showToast", async () => {
        const showToast = vi.fn()
        const d = browserReminderDeliveryDeps({ showToast })

        await deliverTaskReminder(MESSAGE, d)

        expect(showToast).toHaveBeenCalledWith(MESSAGE.toastText)
    })
})
