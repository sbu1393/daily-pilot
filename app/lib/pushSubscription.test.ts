import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* یادآورها — تست هلپر کلاینت Web Push                                 */
/*                                                                     */
/* محیط vitest این پروژه «node» است (بدون jsdom)، پس حداقل stub برای   */
/* window/navigator/Notification/PushManager/fetch ساخته می‌شود —       */
/* همان الگوی offline.test.ts و reminder.test.ts.                       */
/* ------------------------------------------------------------------ */

const windowStub: Record<string, unknown> = {}
const navigatorStub: Record<string, unknown> = {}

vi.stubGlobal("window", windowStub)
vi.stubGlobal("navigator", navigatorStub)

import {
    ensurePushSubscription,
    getVapidPublicKey,
    hasNotificationPermission,
    isPushSupported,
    removePushSubscription,
    sendTestNotification,
    syncReminderSchedule,
    urlBase64ToUint8Array,
} from "./pushSubscription"

const PUBLIC_KEY = "BExamplePublicKeyUrlSafe_-1234567890"

type SubscriptionStub = {
    toJSON: () => unknown
    unsubscribe: ReturnType<typeof vi.fn>
    // در تست، نوع دقیق BufferSource اهمیت ندارد (فقط مقایسه بایتی می‌شود)
    options?: { applicationServerKey?: unknown }
}

// پیش‌فرض: اشتراک با کلید عمومی فعلی ساخته شده (بدون rotation)
function subscriptionStub(json: unknown, applicationServerKey?: unknown): SubscriptionStub {
    return {
        toJSON: () => json,
        unsubscribe: vi.fn(async () => true),
        options: { applicationServerKey: applicationServerKey ?? urlBase64ToUint8Array(PUBLIC_KEY) },
    }
}

function validJson(id = "a") {
    return {
        endpoint: `https://push.example.com/${id}`,
        keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
    }
}

function stubBrowser(options: {
    permission?: "granted" | "denied" | "default" | "absent"
    pushManager?: boolean
    serviceWorker?: boolean
    requestPermission?: () => Promise<string>
}) {
    const permission = options.permission ?? "granted"

    if (permission === "absent") delete windowStub.Notification
    else windowStub.Notification = { permission, requestPermission: options.requestPermission }

    if (options.pushManager === false) delete windowStub.PushManager
    else windowStub.PushManager = function PushManager() {}

    if (options.serviceWorker === false) delete navigatorStub.serviceWorker
    else navigatorStub.serviceWorker = { getRegistration: vi.fn(async () => null), ready: Promise.resolve(null) }
}

function stubRegistration(subscription: SubscriptionStub | null) {
    const subscribe = vi.fn(async () => subscription)
    const registration = {
        pushManager: {
            getSubscription: vi.fn(async () => subscription),
            subscribe,
        },
    }
    ;(navigatorStub.serviceWorker as { getRegistration: ReturnType<typeof vi.fn> }).getRegistration =
        vi.fn(async () => registration)

    return { registration, subscribe }
}

const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
})

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const { status, body } = handler(url, init)
        return jsonResponse(status, body)
    })
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
}

beforeEach(() => {
    for (const key of Object.keys(windowStub)) delete windowStub[key]
    for (const key of Object.keys(navigatorStub)) delete navigatorStub[key]
    vi.stubGlobal("window", windowStub)
    vi.stubGlobal("navigator", navigatorStub)
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", PUBLIC_KEY)
    vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
    vi.unstubAllEnvs()
})

describe("urlBase64ToUint8Array", () => {
    it("Base64URL را با padding درست تبدیل می‌کند", () => {
        expect(Array.from(urlBase64ToUint8Array("AQAB"))).toEqual([1, 0, 1])
        expect(Array.from(urlBase64ToUint8Array("AQ"))).toEqual([1])
        expect(Array.from(urlBase64ToUint8Array(""))).toEqual([])
    })

    it("کاراکترهای - و _ را مثل + و / می‌خواند", () => {
        expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255])
        expect(Array.from(urlBase64ToUint8Array("+/8"))).toEqual([251, 255])
    })

    it("کلید عمومی VAPID واقعی را به ۶۵ بایت تبدیل می‌کند", () => {
        // کلید نمونه‌ی VAPID (uncompressed P-256 point) = 65 بایت
        const key =
            "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM"
        expect(urlBase64ToUint8Array(key).length).toBe(65)
    })
})

describe("getVapidPublicKey", () => {
    it("کلید را trim می‌کند", () => {
        vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", `  ${PUBLIC_KEY}  `)
        expect(getVapidPublicKey()).toBe(PUBLIC_KEY)
    })

    it("نبودِ کلید یا مقدار خالی → null", () => {
        vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "")
        expect(getVapidPublicKey()).toBeNull()
        vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "   ")
        expect(getVapidPublicKey()).toBeNull()
    })
})

describe("isPushSupported", () => {
    it("فقط وقتی Service Worker + Notification + PushManager هر سه هستند", () => {
        stubBrowser({ pushManager: false })
        expect(isPushSupported()).toBe(false)

        stubBrowser({ serviceWorker: false })
        expect(isPushSupported()).toBe(false)

        stubBrowser({ permission: "absent" })
        expect(isPushSupported()).toBe(false)

        stubBrowser({})
        expect(isPushSupported()).toBe(true)
        expect(hasNotificationPermission()).toBe(true)

        stubBrowser({ permission: "denied" })
        expect(isPushSupported()).toBe(true)
        expect(hasNotificationPermission()).toBe(false)
    })
})

describe("ensurePushSubscription", () => {
    it("مرورگر بدون پشتیبانی → UNSUPPORTED", async () => {
        stubBrowser({ pushManager: false })

        expect(await ensurePushSubscription()).toEqual({ ok: false, reason: "UNSUPPORTED" })
    })

    it("بدون کلید عمومی VAPID → NOT_CONFIGURED", async () => {
        stubBrowser({})
        vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "")

        expect(await ensurePushSubscription()).toEqual({ ok: false, reason: "NOT_CONFIGURED" })
    })

    it("بدون مجوز و بدون تعامل کاربر → PERMISSION_DENIED (بدون prompt)", async () => {
        const requestPermission = vi.fn(async () => "denied")
        stubBrowser({ permission: "default", requestPermission })
        const { subscribe } = stubRegistration(null)

        expect(await ensurePushSubscription({ requestPermission: false })).toEqual({
            ok: false,
            reason: "PERMISSION_DENIED",
        })
        expect(requestPermission).not.toHaveBeenCalled()
        expect(subscribe).not.toHaveBeenCalled()
    })

    it("با تعامل کاربر، مجوز گرفته می‌شود و اشتراک ساخته و به سرور فرستاده می‌شود", async () => {
        stubBrowser({ permission: "default", requestPermission: vi.fn(async () => "granted") })
        const { subscribe } = stubRegistration(null)

        const fetchMock = stubFetch(() => ({ status: 201, body: { ok: true, data: { id: "s1", pruned: 0 } } }))

        // subscription تازه‌ساخته‌شده
        subscribe.mockResolvedValueOnce(subscriptionStub(validJson()))

        const result = await ensurePushSubscription({ requestPermission: true })

        expect(result).toEqual({ ok: true, alreadySubscribed: false })
        expect(subscribe).toHaveBeenCalledWith(
            expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.anything() }),
        )

        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe("/api/notifications/subscribe")
        expect(init?.method).toBe("POST")
        expect(JSON.parse(String(init?.body))).toEqual(validJson())
    })

    it("اشتراک موجود → دوباره subscribe نمی‌شود، فقط با سرور هم‌گام می‌شود", async () => {
        stubBrowser({})
        const existing = subscriptionStub(validJson("existing"))
        const { subscribe } = stubRegistration(existing)
        const fetchMock = stubFetch(() => ({ status: 200, body: { ok: true, data: { id: "s1", pruned: 0 } } }))

        const result = await ensurePushSubscription()

        expect(result).toEqual({ ok: true, alreadySubscribed: true })
        expect(subscribe).not.toHaveBeenCalled()
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(validJson("existing"))
    })

    it("اشتراک قدیمی با کلید دیگر (rotation) → لغو و ثبت دوباره با کلید تازه", async () => {
        stubBrowser({})
        const oldKey = urlBase64ToUint8Array("BOldVapidKeyExample1234567890-_abc")
        const stale = subscriptionStub(validJson("stale"), oldKey)
        const subscribe = vi.fn(async () => subscriptionStub(validJson("fresh")))

        ;(navigatorStub.serviceWorker as { getRegistration: ReturnType<typeof vi.fn> }).getRegistration = vi.fn(
            async () => ({ pushManager: { getSubscription: vi.fn(async () => stale), subscribe } }),
        )
        const fetchMock = stubFetch(() => ({ status: 201, body: { ok: true, data: { id: "s2", pruned: 0 } } }))

        const result = await ensurePushSubscription()

        expect(result).toEqual({ ok: true, alreadySubscribed: true })
        expect(stale.unsubscribe).toHaveBeenCalledTimes(1)
        expect(subscribe).toHaveBeenCalledTimes(1)
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(validJson("fresh"))
    })

    it("شکست subscribe (بدون اشتراک قدیمی) → SUBSCRIBE_FAILED", async () => {
        stubBrowser({})
        const subscribe = vi.fn(async () => {
            throw new Error("AbortError")
        })
        ;(navigatorStub.serviceWorker as { getRegistration: ReturnType<typeof vi.fn> }).getRegistration = vi.fn(
            async () => ({ pushManager: { getSubscription: vi.fn(async () => null), subscribe } }),
        )
        stubFetch(() => ({ status: 201, body: { ok: true, data: {} } }))

        expect(await ensurePushSubscription()).toEqual({ ok: false, reason: "SUBSCRIBE_FAILED" })
    })

    it("اشتراک بدون endpoint/keys → SUBSCRIBE_FAILED (به سرور نمی‌رود)", async () => {
        stubBrowser({})
        const { subscribe } = stubRegistration(null)
        subscribe.mockResolvedValueOnce(subscriptionStub({ endpoint: "https://push.example.com/a" }))
        const fetchMock = stubFetch(() => ({ status: 201, body: { ok: true, data: {} } }))

        expect(await ensurePushSubscription()).toEqual({ ok: false, reason: "SUBSCRIBE_FAILED" })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("بدون Service Worker آماده → NO_REGISTRATION (پس از مهلت انتظار، بدون معطلی بی‌نهایت)", async () => {
        vi.useFakeTimers()
        try {
            stubBrowser({})
            ;(navigatorStub.serviceWorker as { ready: unknown }).ready = new Promise(() => undefined)

            const pending = ensurePushSubscription()
            await vi.advanceTimersByTimeAsync(3_001)

            expect(await pending).toEqual({ ok: false, reason: "NO_REGISTRATION" })
        } finally {
            vi.useRealTimers()
        }
    })

    it("رد شدن سرور → SERVER_REJECTED و کلید در نبودِ VAPID → NOT_CONFIGURED", async () => {
        stubBrowser({})
        stubRegistration(subscriptionStub(validJson()))
        stubFetch(() => ({ status: 500, body: { ok: false, error: { code: "INTERNAL", message: "x" } } }))

        expect(await ensurePushSubscription()).toEqual({ ok: false, reason: "SERVER_REJECTED" })

        stubFetch(() => ({
            status: 503,
            body: { ok: false, error: { code: "PUSH_NOT_CONFIGURED", message: "x" } },
        }))
        expect(await ensurePushSubscription()).toEqual({ ok: false, reason: "NOT_CONFIGURED" })

        stubFetch(() => ({ status: 429, body: { ok: false, error: { code: "RATE_LIMITED", message: "x" } } }))
        expect(await ensurePushSubscription()).toEqual({ ok: false, reason: "RATE_LIMITED" })
    })
})

describe("removePushSubscription", () => {
    it("اشتراک محلی را لغو و به سرور اطلاع می‌دهد", async () => {
        stubBrowser({})
        const subscription = subscriptionStub(validJson())
        stubRegistration(subscription)
        const fetchMock = stubFetch(() => ({ status: 200, body: { ok: true, data: { removed: 1 } } }))

        expect(await removePushSubscription()).toEqual({ ok: true })
        expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)

        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe("/api/notifications/unsubscribe")
        expect(JSON.parse(String(init?.body))).toEqual({ endpoint: validJson().endpoint })
    })

    it("بدون اشتراک محلی → ok بدون درخواست شبکه", async () => {
        stubBrowser({})
        stubRegistration(null)
        const fetchMock = stubFetch(() => ({ status: 200, body: { ok: true, data: { removed: 0 } } }))

        expect(await removePushSubscription()).toEqual({ ok: true })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("شکست سرور → SERVER_REJECTED (لغو محلی انجام شده)", async () => {
        stubBrowser({})
        const subscription = subscriptionStub(validJson())
        stubRegistration(subscription)
        stubFetch(() => ({ status: 500, body: { ok: false, error: { code: "INTERNAL", message: "x" } } }))

        expect(await removePushSubscription()).toEqual({ ok: false, reason: "SERVER_REJECTED" })
        expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)
    })

    it("مرورگر بدون پشتیبانی → UNSUPPORTED", async () => {
        stubBrowser({ pushManager: false })

        expect(await removePushSubscription()).toEqual({ ok: false, reason: "UNSUPPORTED" })
    })
})

describe("syncReminderSchedule", () => {
    it("برنامه‌ی یادآور را برای آینه‌ی سرور می‌فرستد", async () => {
        const fetchMock = stubFetch(() => ({ status: 200, body: { ok: true, data: {} } }))

        expect(await syncReminderSchedule({ enabled: true, time: "07:30" })).toEqual({ ok: true })

        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe("/api/notifications/reminder")
        expect(init?.method).toBe("POST")
        expect(JSON.parse(String(init?.body))).toEqual({ enabled: true, time: "07:30" })
    })

    it("شکست سرور یا rate limit بی‌صدا گزارش می‌شود (یادآور داخلی دست‌نخورده)", async () => {
        stubFetch(() => ({ status: 429, body: { ok: false, error: { code: "RATE_LIMITED", message: "x" } } }))
        expect(await syncReminderSchedule({ enabled: true, time: "09:00" })).toEqual({
            ok: false,
            reason: "RATE_LIMITED",
        })

        stubFetch(() => ({ status: 500, body: { ok: false, error: { code: "INTERNAL", message: "x" } } }))
        expect(await syncReminderSchedule({ enabled: true, time: "09:00" })).toEqual({
            ok: false,
            reason: "SERVER_REJECTED",
        })

        vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))))
        expect(await syncReminderSchedule({ enabled: false, time: "09:00" })).toEqual({
            ok: false,
            reason: "SERVER_REJECTED",
        })
    })
})

describe("sendTestNotification", () => {
    it("خروجی موفق سرور را با شمارنده‌ها برمی‌گرداند", async () => {
        stubFetch(() => ({ status: 200, body: { ok: true, data: { sent: 2, failed: 0, removed: 1 } } }))

        expect(await sendTestNotification()).toEqual({ ok: true, sent: 2, failed: 0, removed: 1 })
    })

    it("خطاهای شناخته‌شده به reason نگاشت می‌شوند", async () => {
        stubFetch(() => ({
            status: 503,
            body: { ok: false, error: { code: "PUSH_NOT_CONFIGURED", message: "x" } },
        }))
        expect(await sendTestNotification()).toEqual({ ok: false, reason: "NOT_CONFIGURED" })

        stubFetch(() => ({ status: 429, body: { ok: false, error: { code: "RATE_LIMITED", message: "x" } } }))
        expect(await sendTestNotification()).toEqual({ ok: false, reason: "RATE_LIMITED" })

        stubFetch(() => ({ status: 500, body: { ok: false, error: { code: "INTERNAL", message: "x" } } }))
        expect(await sendTestNotification()).toEqual({ ok: false, reason: "SERVER_REJECTED" })

        vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))))
        expect(await sendTestNotification()).toEqual({ ok: false, reason: "SERVER_REJECTED" })
    })
})
