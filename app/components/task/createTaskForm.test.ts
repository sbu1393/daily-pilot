import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Task create form — pure contract                                    */
/*                                                                     */
/* این repo jsdom ندارد (قید صفر وابستگی)، پس منطق فرم مثل              */
/* `planProposalView.test.ts` به‌صورت pure تست می‌شود، نه با رندر واقعی.    */
/* هدف: ثابت کردن اینکه «ارسال بدون دسته» در هیچ حالتی ممکن نیست.        */
/* ------------------------------------------------------------------ */

import {
    buildCreateTaskBody,
    CATEGORY_REQUIRED_MESSAGE,
    TASK_CATEGORIES,
    TITLE_TOO_SHORT_MESSAGE,
    validateCreateForm,
    type TaskCategoryKey,
} from "./createTaskForm"

const SCHEDULED_DATE = "2026-03-05T20:30:00.000Z"

describe("category selector options", () => {
    it("renders all eight canonical categories with an icon and a Persian label", () => {
        expect(TASK_CATEGORIES).toHaveLength(8)
        for (const c of TASK_CATEGORIES) {
            expect(c.icon).toBeTruthy()
            expect(c.label).toBeTruthy()
        }
    })

    it("exposes them in the same order as the canonical vocabulary", () => {
        expect(TASK_CATEGORIES.map((c) => c.key)).toEqual([
            "home",
            "work",
            "transport",
            "shopping",
            "learning",
            "health",
            "leisure",
            "personal",
        ])
    })

    it("has no 'Urgent' option — urgency is priority", () => {
        expect(TASK_CATEGORIES.map((c) => c.key)).not.toContain("Urgent")
    })
})

describe("validateCreateForm — category is required", () => {
    it("accepts a canonical selection", () => {
        for (const c of TASK_CATEGORIES) {
            const r = validateCreateForm("خرید نان", c.key)
            expect(r.ok).toBe(true)
            if (r.ok) expect(r.category).toBe(c.key)
        }
    })

    it("blocks submit when no category is selected", () => {
        const r = validateCreateForm("خرید نان", null)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toBe(CATEGORY_REQUIRED_MESSAGE)
    })

    it("blocks submit for a key outside the vocabulary", () => {
        for (const bad of ["Work", "Urgent", "", "universe"] as unknown as TaskCategoryKey[]) {
            const r = validateCreateForm("خرید نان", bad)
            expect(r.ok).toBe(false)
        }
    })

    it("reports the title problem first when the title is too short", () => {
        const r = validateCreateForm("ab", null)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toBe(TITLE_TOO_SHORT_MESSAGE)
    })

    it("still requires a category when the title is valid", () => {
        const r = validateCreateForm("ab", "work")
        expect(r.ok).toBe(false)
    })
})

describe("buildCreateTaskBody", () => {
    it("includes exactly title, scheduledDate and the selected category", () => {
        const body = buildCreateTaskBody("  خرید نان  ", SCHEDULED_DATE, "shopping")
        expect(body).toEqual({
            title: "خرید نان",
            scheduledDate: SCHEDULED_DATE,
            category: "shopping",
        })
        expect(Object.keys(body).sort()).toEqual(["category", "scheduledDate", "title"])
    })

    it("never sends dayKey from the client (§6.2.2.1)", () => {
        const body = buildCreateTaskBody("کار", SCHEDULED_DATE, "work")
        expect(body).not.toHaveProperty("dayKey")
    })
})
