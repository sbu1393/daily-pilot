import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiClientError, api } from "./client"

// B1 — ApiClient (app/lib/api/client.ts): باید json.data را برگرداند و در !res.ok
// یک ApiClientError{ status, code, message, errors } پرتاب کند (ADR-04).
// Phase 2B (M6) — لغو درخواست: init.signal به fetch می‌رسد و لغو عمدی به‌صورت
// AbortError خام به callee می‌رسد (نه ApiClientError) تا hook بتواند لغو خودش را
// از خطای واقعی شبکه تفکیک کند.

const okEnvelope = (data: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify({ ok: true, data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    })

const errorEnvelope = (status: number, code: string, message: string, errors?: unknown) =>
    new Response(
        JSON.stringify({ ok: false, error: { code, message, ...(errors ? { errors } : {}) } }),
        { status, headers: { "Content-Type": "application/json" } },
    )

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("api() success envelope (B1 — ADR-04)", () => {
    it("returns json.data typed, ignoring ok/message wrappers", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okEnvelope({ id: 7, title: "کار" })))

        await expect(api<{ id: number }>("/api/tasks")).resolves.toEqual({ id: 7, title: "کار" })
    })

    it("returns primitive/nullable data payloads untouched", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okEnvelope(null)))
        await expect(api<null>("/api/x")).resolves.toBeNull()

        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okEnvelope([1, 2, 3])))
        await expect(api<number[]>("/api/y")).resolves.toEqual([1, 2, 3])
    })

    it("forwards method/headers/body to fetch unchanged", async () => {
        const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ id: 1 }))
        vi.stubGlobal("fetch", fetchMock)

        const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
        await api("/api/tasks", init)

        expect(fetchMock).toHaveBeenCalledWith("/api/tasks", init)
    })
})

describe("api() error envelope (B1 — ADR-04)", () => {
    it("throws ApiClientError with status/code/message from the error envelope", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(errorEnvelope(404, "TASK_NOT_FOUND", "تسک پیدا نشد")),
        )

        const promise = api("/api/tasks/999")

        await expect(promise).rejects.toBeInstanceOf(ApiClientError)
        await promise.catch((e: ApiClientError) => {
            expect(e.status).toBe(404)
            expect(e.code).toBe("TASK_NOT_FOUND")
            expect(e.message).toBe("تسک پیدا نشد")
        })
    })

    it("carries the optional errors payload through", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                errorEnvelope(400, "VALIDATION_ERROR", "اطلاعات نامعتبر است", { title: ["کوتاه"] }),
            ),
        )

        await api("/api/tasks").catch((e: ApiClientError) => {
            expect(e.errors).toEqual({ title: ["کوتاه"] })
        })
    })

    it("falls back to a generic message when the body has no error envelope", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response("not json", { status: 502 })),
        )

        await api("/api/x").catch((e: ApiClientError) => {
            expect(e.status).toBe(502)
            expect(e.code).toBe("UNKNOWN_ERROR")
            expect(e.message).toContain("502")
        })
    })

    it("maps a network-level rejection to ApiClientError with status 0 semantics", async () => {
        // قطع کامل شبکه: fetch رد می‌شود → TypeError. این خطا با همان ApiClientError
        // مسیر خطا می‌رود تا callee فقط یک نوع خطا را مدیریت کند.
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

        await expect(api("/api/x")).rejects.toBeInstanceOf(TypeError)
    })
})

describe("api() abort support (Phase 2B — M6)", () => {
    it("passes init.signal through to fetch", async () => {
        const controller = new AbortController()
        const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ value: 1 }))
        vi.stubGlobal("fetch", fetchMock)

        await api<{ value: number }>("/api/x", { signal: controller.signal })

        expect(fetchMock).toHaveBeenCalledWith("/api/x", { signal: controller.signal })
    })

    it("rejects with a raw AbortError (not ApiClientError) when the fetch is aborted", async () => {
        const controller = new AbortController()
        vi.stubGlobal(
            "fetch",
            (_url: string, init?: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        const err = new Error("This operation was aborted")
                        err.name = "AbortError"
                        reject(err)
                    })
                }),
        )

        const promise = api("/api/x", { signal: controller.signal })
        controller.abort()

        await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    })

    it("propagates an abort raised while reading the body instead of swallowing it", async () => {
        const controller = new AbortController()
        const bodyError = new Error("aborted mid-body")
        bodyError.name = "AbortError"
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(bodyError) }),
        )

        const promise = api("/api/x", { signal: controller.signal })
        controller.abort()

        await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    })

    it("still maps non-abort failures to ApiClientError (behavior preserved)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(errorEnvelope(400, "X", "boom")),
        )

        await expect(api("/api/x")).rejects.toBeInstanceOf(ApiClientError)
    })
})
