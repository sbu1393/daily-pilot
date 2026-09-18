// فاز ۳ — گام ۴: تست‌های productEvent.service (fail-open bounded persistence)
// پوشش: insert موفق، event نامعتبر/ناشناخته → بدون insert، شکست Prisma → fail-open،
// timeout → fail-open، recordError روی شکست (بدون recursion)، requestId nullable و
// non-unique، await-پذیری، و عدم شکست business caller.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
    recordProductEvent,
    PRODUCT_EVENT_TIMEOUT_MS,
} from "./productEvent.service"

const CONTEXT = {
    requestId: "req-123",
    endpoint: "POST /api/tasks",
    feature: "tasks",
}

describe("recordProductEvent", () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    // ------------------------------------------------------------------
    // 1) valid event → insert
    // ------------------------------------------------------------------

    it("inserts a valid event with whitelisted properties", async () => {
        const create = vi.fn().mockResolvedValue({})
        const result = await recordProductEvent(
            7,
            "task.created",
            { taskId: "t1", category: "work", status: "todo" },
            CONTEXT,
            { create },
            { skipTimeoutGuard: true },
        )

        expect(result).toEqual({ recorded: true, eventName: "task.created" })
        expect(create).toHaveBeenCalledTimes(1)
        const args = create.mock.calls[0][0]
        expect(args.data.userId).toBe(7)
        expect(args.data.requestId).toBe("req-123")
        expect(args.data.eventName).toBe("task.created")
        expect(args.data.feature).toBe("tasks")
        expect(args.data.properties).toEqual({ taskId: "t1", category: "work", status: "todo" })
    })

    it("awaits the returned promise before resolving (awaitable, not fire-and-forget)", async () => {
        let resolveInsert: (v: unknown) => void
        const create = vi.fn().mockImplementation(
            () => new Promise((resolve) => { resolveInsert = resolve }),
        )
        const promise = recordProductEvent(
            7,
            "planner.day_viewed",
            undefined,
            CONTEXT,
            { create },
            { skipTimeoutGuard: true },
        )
        let settled = false
        void promise.then(() => { settled = true })
        await new Promise((r) => setTimeout(r, 10))
        expect(settled).toBe(false) // هنوز insert resolve نشده → promise در انتظار است
        resolveInsert!({})
        expect(await promise).toEqual({ recorded: true, eventName: "planner.day_viewed" })
    })

    // ------------------------------------------------------------------
    // 2) invalid / unknown → no insert
    // ------------------------------------------------------------------

    it("does NOT insert on unknown event name", async () => {
        const create = vi.fn()
        const result = await recordProductEvent(
            7,
            "task.exploded",
            {},
            CONTEXT,
            { create },
            { skipTimeoutGuard: true },
        )
        expect(result).toEqual({ recorded: false, reason: "invalid_event" })
        expect(create).not.toHaveBeenCalled()
    })

    it("does NOT insert on unknown property", async () => {
        const create = vi.fn()
        const result = await recordProductEvent(
            7,
            "task.created",
            { taskId: "t1", title: "sensitive content" },
            CONTEXT,
            { create },
            { skipTimeoutGuard: true },
        )
        expect(result).toEqual({ recorded: false, reason: "invalid_event" })
        expect(create).not.toHaveBeenCalled()
    })

    it("does NOT insert on invalid userId (client-derived guard)", async () => {
        const create = vi.fn()
        for (const badUserId of [0, -1, 2.5, NaN, "7" as unknown as number, null as unknown as number]) {
            const result = await recordProductEvent(
                badUserId,
                "task.created",
                { taskId: "t1" },
                CONTEXT,
                { create },
                { skipTimeoutGuard: true },
            )
            expect(result).toEqual({ recorded: false, reason: "invalid_event" })
        }
        expect(create).not.toHaveBeenCalled()
    })

    it("does NOT insert on non-object properties", async () => {
        const create = vi.fn()
        const result = await recordProductEvent(
            7,
            "task.created",
            "not-an-object",
            CONTEXT,
            { create },
            { skipTimeoutGuard: true },
        )
        expect(result).toEqual({ recorded: false, reason: "invalid_event" })
        expect(create).not.toHaveBeenCalled()
    })

    // ------------------------------------------------------------------
    // 3) fail-open: شکست insert هرگز throw نمی‌گیرد
    // ------------------------------------------------------------------

    it("swallows Prisma insert failure and returns persistence_failed (fail-open)", async () => {
        const create = vi.fn().mockRejectedValue(new Error("DB down"))
        const result = await recordProductEvent(
            7,
            "task.created",
            { taskId: "t1" },
            CONTEXT,
            { create },
            { skipTimeoutGuard: true },
        )
        expect(result).toEqual({ recorded: false, reason: "persistence_failed" })
    })

    it("business caller never throws due to analytics failure (await with rejection-guard)", async () => {
        const create = vi.fn().mockRejectedValue(new Error("DB down"))
        // الگوی caller: await — نباید هیچ‌وقت reject شود
        await expect(
            recordProductEvent(7, "task.created", { taskId: "t1" }, CONTEXT, { create }, { skipTimeoutGuard: true }),
        ).resolves.toEqual({ recorded: false, reason: "persistence_failed" })
    })

    it("swallows timeout and returns persistence_timeout (bounded write)", async () => {
        const create = vi.fn().mockImplementation(() => new Promise(() => {})) // هرگز settle نمی‌شود
        const result = await recordProductEvent(
            7,
            "task.created",
            { taskId: "t1" },
            CONTEXT,
            { create },
            { timeoutMs: 25 }, // timeout واقعی؛ skipTimeoutGuard false
        )
        expect(result).toEqual({ recorded: false, reason: "persistence_timeout" })
    })

    it("uses the Phase 2 pattern default timeout (2000ms)", () => {
        expect(PRODUCT_EVENT_TIMEOUT_MS).toBe(2000)
    })

    it("late insert rejection after timeout does not crash (no unhandledRejection)", async () => {
        let rejectInsert: (e: Error) => void
        const create = vi.fn().mockImplementation(
            () => new Promise((_resolve, reject) => { rejectInsert = reject }),
        )
        const result = await recordProductEvent(
            7,
            "task.created",
            { taskId: "t1" },
            CONTEXT,
            { create },
            { timeoutMs: 20 },
        )
        expect(result).toEqual({ recorded: false, reason: "persistence_timeout" })
        // rejection دیرهنگام — نباید unhandledRejection بدهد
        rejectInsert!(new Error("late failure"))
        await new Promise((r) => setTimeout(r, 10))
    })

    it("never rejects for any input combination", async () => {
        const create = vi.fn().mockRejectedValue(new Error("x"))
        const hostile: Array<[number, unknown, unknown]> = [
            [7, "task.created", undefined],
            [7, null, null],
            [0, "task.created", {}],
            [7, "task.created", { bad: { deep: true } }],
        ]
        for (const [userId, name, props] of hostile) {
            await expect(
                recordProductEvent(userId, name, props, CONTEXT, { create }, { skipTimeoutGuard: true }),
            ).resolves.toBeInstanceOf(Object)
        }
    })

    // ------------------------------------------------------------------
    // 4) recordError روی شکست — بدون recursion
    //
    // ACCEPTED DEVIATION (فاز ۲ — F9): این فراخوانی داخل helper **همگام**
    // (`reportPersistenceFailure`) است و عمداً await نمی‌شود؛ مسیر fail-open آنالیتیکس فاز ۳
    // است و تصمیم پذیرش آن جداگانه اخذ می‌شود. هیچ recursion ای یا persistence دوباره‌ای رخ
    // نمی‌دهد (این تست همان را اثبات می‌کند) و قرارداد سرویس دست‌نخورده باقی مانده است.
    // ------------------------------------------------------------------

    it("invokes recordError on persistence failure without recursion", async () => {
        const recordErrorMod = await import("@/src/lib/observability/recordError")
        // recordError فاز ۲ async است (A3: persistence پیش از resolve) → mock باید Promise برگرداند
        const spy = vi.spyOn(recordErrorMod, "recordError").mockImplementation(async () => {})
        try {
            const create = vi.fn().mockRejectedValue(new Error("DB down"))
            const result = await recordProductEvent(
                7,
                "task.created",
                { taskId: "t1" },
                CONTEXT,
                { create },
                { skipTimeoutGuard: true },
            )
            expect(result).toEqual({ recorded: false, reason: "persistence_failed" })
            expect(spy).toHaveBeenCalledTimes(1)
            const [error, ctx] = spy.mock.calls[0]
            expect((error as Error).message).toBe("PRODUCT_EVENT_RECORD_FAILED")
            expect(ctx.requestId).toBe("req-123")
            expect(ctx.endpoint).toBe("POST /api/tasks")
            expect(ctx.feature).toBe("tasks")
            // هیچ properties حساسی از caller وارد گزارش نشده
            expect(JSON.stringify(spy.mock.calls[0])).not.toContain("t1")
        } finally {
            spy.mockRestore()
        }
    })

    it("reports a fixed error factor without caller properties (no raw property logging)", async () => {
        const recordErrorMod = await import("@/src/lib/observability/recordError")
        // recordError فاز ۲ async است (A3: persistence پیش از resolve) → mock باید Promise برگرداند
        const spy = vi.spyOn(recordErrorMod, "recordError").mockImplementation(async () => {})
        try {
            const create = vi.fn().mockRejectedValue(new Error("DB down"))
            await recordProductEvent(
                7,
                "task.created",
                { taskId: "super-secret-task-id" },
                CONTEXT,
                { create },
                { skipTimeoutGuard: true },
            )
            const payload = JSON.stringify(spy.mock.calls[0])
            expect(payload).not.toContain("super-secret-task-id")
        } finally {
            spy.mockRestore()
        }
    })

    // ------------------------------------------------------------------
    // 5) requestId — nullable و non-unique (correlation only)
    // ------------------------------------------------------------------

    it("requestId is nullable — empty requestId persists as null", async () => {
        const create = vi.fn().mockResolvedValue({})
        await recordProductEvent(
            7,
            "task.created",
            { taskId: "t1" },
            { requestId: "", endpoint: "POST /api/tasks", feature: "tasks" },
            { create },
            { skipTimeoutGuard: true },
        )
        expect(create.mock.calls[0][0].data.requestId).toBeNull()
    })

    it("requestId is correlation only — identical requestIds persist side by side (non-unique, no dedup)", async () => {
        const create = vi.fn().mockResolvedValue({})
        for (let i = 0; i < 3; i++) {
            await recordProductEvent(
                7,
                "planner.day_viewed",
                undefined,
                CONTEXT, // همان requestId هر بار
                { create },
                { skipTimeoutGuard: true },
            )
        }
        expect(create).toHaveBeenCalledTimes(3) // بدون dedup — هر فراخوانی insert مستقل
    })

    // ------------------------------------------------------------------
    // 6) خروجی = دقیقاً همان properties validated
    // ------------------------------------------------------------------

    it("persists exactly the validated whitelisted properties (no extra serialization)", async () => {
        const create = vi.fn().mockResolvedValue({})
        await recordProductEvent(
            7,
            "ai.analysis_succeeded",
            { units: 2, aiSource: "1xai", status: "ok", prompt: "LEAK" },
            CONTEXT,
            { create },
            { skipTimeoutGuard: true },
        )
        // prompt غیرمجاز است → کل event رد می‌شود (no insert) — نه نیمه‌ذخیره
        expect(create).not.toHaveBeenCalled()
    })

    it("undefined properties become empty properties object", async () => {
        const create = vi.fn().mockResolvedValue({})
        await recordProductEvent(
            7,
            "planner.day_viewed",
            undefined,
            CONTEXT,
            { create },
            { skipTimeoutGuard: true },
        )
        expect(create.mock.calls[0][0].data.properties).toEqual({})
    })

    it("test env without injected create performs no real I/O", async () => {
        // بدون deps.create در VITEST — باید بدون touching getPrisma resolve شود
        const result = await recordProductEvent(7, "task.created", { taskId: "t1" }, CONTEXT)
        expect(result).toEqual({ recorded: true, eventName: "task.created" })
    })
})
