import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    fetchAdminErrors,
    fetchAdminOverview,
    fetchAdminUserAiUsage,
    fetchAdminUserActivity,
    fetchAdminUserDetail,
    fetchAdminUserErrors,
    fetchAdminUsers,
    toAdminRequestError,
    toAdminErrorMessage,
} from "./adminClient"
import { ApiClientError } from "@/app/lib/api/client"

/* ------------------------------------------------------------------ */
/* Step 7 — لایه‌ی داده‌ی Admin: endpointها + قرارداد ADR-04.            */
/* fetch سراسری mock می‌شود (محیط node بدون DOM — بدون dependency جدید). */
/* ------------------------------------------------------------------ */

beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const ok = (data: unknown) =>
    Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }))

const fail = (status: number, code: string, message: string) =>
    Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: { code, message } }), { status }),
    )

describe("admin client — endpoint قراردادها", () => {
    it("fetchAdminOverview hits GET /api/admin/overview and unwraps data", async () => {
        const overview = {
            users: { dau: 1, wau: 2, mau: 3 },
            activity: { totalInWindow: 0, byEventName: [], byFeature: [], windowHours: 24 },
            aiQuota: null,
            errors: { totalInWindow: 0, bySeverity: [], topErrors: [], windowHours: 24 },
        }
        vi.mocked(fetch).mockReturnValue(ok(overview) as never)

        await expect(fetchAdminOverview()).resolves.toEqual(overview)
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/overview", expect.anything())
    })

    it("fetchAdminUsers hits GET /api/admin/users?<query>", async () => {
        const page = { items: [], page: 1, limit: 20, total: 0, hasMore: false }
        vi.mocked(fetch).mockReturnValue(ok(page) as never)

        await expect(fetchAdminUsers("page=2&limit=20")).resolves.toEqual(page)
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users?page=2&limit=20", expect.anything())
    })

    it("per-user endpoints encode the id and append the query", async () => {
        vi.mocked(fetch).mockReturnValue(ok({}) as never)

        await fetchAdminUserDetail("42")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users/42", expect.anything())

        await fetchAdminUserActivity("42", "page=1&limit=10")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users/42/activity?page=1&limit=10", expect.anything())

        await fetchAdminUserAiUsage("42", "page=1&limit=10")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users/42/ai-usage?page=1&limit=10", expect.anything())

        await fetchAdminUserErrors("42", "page=1&limit=10")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users/42/errors?page=1&limit=10", expect.anything())
    })

    it("fetchAdminErrors hits GET /api/admin/errors?<query>", async () => {
        vi.mocked(fetch).mockReturnValue(ok({ items: [] }) as never)
        await fetchAdminErrors("severity=ERROR&page=1&limit=20")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(
            "/api/admin/errors?severity=ERROR&page=1&limit=20",
            expect.anything(),
        )
    })

    it("passes AbortSignal through to fetch (الگوی useDaySuggestion)", async () => {
        vi.mocked(fetch).mockReturnValue(ok({}) as never)
        const controller = new AbortController()
        await fetchAdminOverview(controller.signal)
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(
            "/api/admin/overview",
            expect.objectContaining({ signal: controller.signal }),
        )
    })
})

describe("admin client — خطاها مطابق ADR-04", () => {
    it.each([
        [401, "UNAUTHORIZED", "Unauthorized"],
        [403, "ADMIN_FORBIDDEN", "دسترسی مدیریتی لازم است"],
        [404, "USER_NOT_FOUND", "کاربر یافت نشد"],
        [500, "INTERNAL", "Server error"],
    ])("maps HTTP %i %s to ApiClientError with status/code", async (status, code, message) => {
        vi.mocked(fetch).mockReturnValue(fail(status, code, message) as never)

        await expect(fetchAdminOverview()).rejects.toMatchObject({
            name: "ApiClientError",
            status,
            code,
            message,
        })
    })
})

describe("admin client — مبدل‌های خطا", () => {
    it("preserves status/code from ApiClientError", () => {
        const err = new ApiClientError(403, "ADMIN_FORBIDDEN", "دسترسی مدیریتی لازم است")
        expect(toAdminRequestError(err)).toEqual({
            status: 403,
            code: "ADMIN_FORBIDDEN",
            message: "دسترسی مدیریتی لازم است",
        })
        expect(toAdminErrorMessage(err)).toBe("دسترسی مدیریتی لازم است")
    })

    it("maps unknown errors to a generic network error without leaking internals", () => {
        const mapped = toAdminRequestError(new Error("socket hang up"))
        expect(mapped.status).toBe(0)
        expect(mapped.code).toBe("NETWORK_ERROR")
        expect(toAdminErrorMessage("boom")).toBe("خطای ناشناخته")
    })
})
