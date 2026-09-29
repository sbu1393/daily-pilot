// AI Quota — اعلام تغییر سهمیه بعد از عملیات AI
//
// این تست‌ها قفل می‌کنند که UI **بعد از هر تلاش** — چه موفق، چه ناموفق — تازه می‌شود.
// نکتهٔ اصلی: چون release پیش از رسیدن پاسخ به کلاینت انجام می‌شود، اعلام در `finally`
// یعنی عددی که UI می‌گیرد همیشه نهایی است و «مصرفِ نیمه‌کاره» نشان داده نمی‌شود.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AI_QUOTA_CHANGED_EVENT, announceAiQuotaChanged } from "./aiQuotaEvents"

describe("announceAiQuotaChanged", () => {
    beforeEach(() => {
        // محیط تست node است و window ندارد؛ یک حداقل شبیه‌سازی می‌سازیم.
        ;(globalThis as any).window = {
            dispatchEvent: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }
    })

    afterEach(() => {
        delete (globalThis as any).window
    })

    it("رویداد درست را پخش می‌کند", () => {
        announceAiQuotaChanged()

        const dispatch = (globalThis as any).window.dispatchEvent as ReturnType<typeof vi.fn>
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(dispatch.mock.calls[0][0].type).toBe(AI_QUOTA_CHANGED_EVENT)
    })

    it("در نبودِ window بی‌اثر است (تست/سرور)", () => {
        delete (globalThis as any).window

        expect(() => announceAiQuotaChanged()).not.toThrow()
    })
})

describe("fetchPlanProposal — اعلام تغییر سهمیه", () => {
    beforeEach(() => {
        vi.resetModules()
        ;(globalThis as any).window = { dispatchEvent: vi.fn() }
    })

    afterEach(() => {
        delete (globalThis as any).window
    })

    function validProposal() {
        return {
            basis: { dayKey: "2026-09-15", planVersion: 1 },
            planned: [],
            unfitted: [],
            plannedMinutes: 0,
            remainingMinutes: 0,
        }
    }

    it("بعد از موفقیت اعلام می‌کند", async () => {
        vi.doMock("@/app/lib/api/client", () => ({
            api: vi.fn().mockResolvedValue(validProposal()),
            ApiClientError: class extends Error {},
        }))

        const { fetchPlanProposal } = await import("@/app/lib/planner/planProposalFlow")
        await fetchPlanProposal("2026-09-15")

        const dispatch = (globalThis as any).window.dispatchEvent as ReturnType<typeof vi.fn>
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(dispatch.mock.calls[0][0].type).toBe(AI_QUOTA_CHANGED_EVENT)
    })

    it("بعد از شکست هم اعلام می‌کند (چون quota آزاد شده) و خطا را دوباره پرتاب می‌کند", async () => {
        vi.doMock("@/app/lib/api/client", () => ({
            api: vi.fn().mockRejectedValue(new Error("boom")),
            ApiClientError: class extends Error {},
        }))

        const { fetchPlanProposal } = await import("@/app/lib/planner/planProposalFlow")

        await expect(fetchPlanProposal("2026-09-15")).rejects.toThrow("boom")

        const dispatch = (globalThis as any).window.dispatchEvent as ReturnType<typeof vi.fn>
        // اعلام باید حتی در مسیر شکست هم رخ دهد تا UI رزروِ آزادشده را نشان دهد.
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(dispatch.mock.calls[0][0].type).toBe(AI_QUOTA_CHANGED_EVENT)
    })

    it("پاسخ نامعتبر هم اعلام می‌کند (reserve انجام شده بود)", async () => {
        vi.doMock("@/app/lib/api/client", () => ({
            api: vi.fn().mockResolvedValue({ nonsense: true }),
            ApiClientError: class extends Error {},
        }))

        const { fetchPlanProposal } = await import("@/app/lib/planner/planProposalFlow")

        await expect(fetchPlanProposal("2026-09-15")).rejects.toThrow("پاسخ سرور نامعتبر است")

        const dispatch = (globalThis as any).window.dispatchEvent as ReturnType<typeof vi.fn>
        expect(dispatch).toHaveBeenCalledTimes(1)
    })
})
