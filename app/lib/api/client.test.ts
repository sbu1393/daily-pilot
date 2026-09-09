import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiClientError, api } from "./client"

// B1 — ApiClient (app/lib/api/client.ts): باید json.data را برگرداند و در !res.ok
// یک ApiClientError{ status, code, message, errors } پرتاب کند (ADR-04).

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    })
}

describe("api() — success path", () => {
    const fetchMock = vi.fn()

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("returns json.data (typed) on a 2xx response", async () => {
        const task = { id: "t1", text: "خرید", priority: null }
        fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: task }, 200))
        vi.stubGlobal("fetch", fetchMock)

        await expect(api<typeof task>("/api/tasks")).resolves.toEqual(task)
    })

    it("passes url and init through to fetch unchanged", async () => {
        const init: RequestInit = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "خرید" }),
        }
        fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { id: "t1" } }, 201))
        vi.stubGlobal("fetch", fetchMock)

        await api("/api/tasks", init)

        expect(fetchMock).toHaveBeenCalledWith("/api/tasks", init)
    })

    it("returns undefined when the success envelope carries no data", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ ok: true }, 200))
        vi.stubGlobal("fetch", fetchMock)

        await expect(api("/api/x")).resolves.toBeUndefined()
    })
})

describe("api() — ADR-04 error envelope", () => {
    const fetchMock = vi.fn()

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("throws ApiClientError with status, code, and message from the error envelope", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(
                { ok: false, error: { code: "TASK_NOT_FOUND", message: "تسک پیدا نشد" } },
                404,
            ),
        )
        vi.stubGlobal("fetch", fetchMock)

        const err = (await api("/api/tasks/t1").catch((e) => e)) as ApiClientError

        expect(err).toBeInstanceOf(ApiClientError)
        expect(err).toBeInstanceOf(Error)
        expect(err.status).toBe(404)
        expect(err.code).toBe("TASK_NOT_FOUND")
        expect(err.message).toBe("تسک پیدا نشد")
    })

    it("preserves the errors detail field from the error envelope", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(
                {
                    ok: false,
                    error: {
                        code: "VALIDATION_ERROR",
                        message: "اطلاعات نامعتبر است",
                        errors: { fieldErrors: { text: ["کوتاه است"] } },
                    },
                },
                400,
            ),
        )
        vi.stubGlobal("fetch", fetchMock)

        const err = (await api("/api/tasks").catch((e) => e)) as ApiClientError

        expect(err.errors).toEqual({ fieldErrors: { text: ["کوتاه است"] } })
        expect(err.status).toBe(400)
    })

    it("falls back to UNKNOWN_ERROR when the error envelope has no code (transition-friendly)", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ ok: false, error: { message: "پیام قدیمی" } }, 500),
        )
        vi.stubGlobal("fetch", fetchMock)

        const err = (await api("/api/x").catch((e) => e)) as ApiClientError

        expect(err.code).toBe("UNKNOWN_ERROR")
        expect(err.message).toBe("پیام قدیمی")
        expect(err.status).toBe(500)
    })

    it("falls back to the legacy top-level message when the error object is absent", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ message: "خطای سرور" }, 500))
        vi.stubGlobal("fetch", fetchMock)

        const err = (await api("/api/x").catch((e) => e)) as ApiClientError

        expect(err.code).toBe("UNKNOWN_ERROR")
        expect(err.message).toBe("خطای سرور")
    })

    it("uses a generic status-based message when the error body carries no message", async () => {
        fetchMock.mockResolvedValue(jsonResponse({}, 503))
        vi.stubGlobal("fetch", fetchMock)

        const err = (await api("/api/x").catch((e) => e)) as ApiClientError

        expect(err.code).toBe("UNKNOWN_ERROR")
        expect(err.message).toBe("درخواست ناموفق بود (503)")
        expect(err.status).toBe(503)
    })

    it("tolerates a non-JSON error body", async () => {
        fetchMock.mockResolvedValue(new Response("Internal Server Error", { status: 500 }))
        vi.stubGlobal("fetch", fetchMock)

        const err = (await api("/api/x").catch((e) => e)) as ApiClientError

        expect(err).toBeInstanceOf(ApiClientError)
        expect(err.code).toBe("UNKNOWN_ERROR")
        expect(err.status).toBe(500)
    })
})

describe("api() — network failures", () => {
    const fetchMock = vi.fn()

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("propagates a network TypeError unwrapped (offline sync relies on this)", async () => {
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
        vi.stubGlobal("fetch", fetchMock)

        await expect(api("/api/x")).rejects.toThrow(TypeError)
    })
})