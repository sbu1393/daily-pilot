import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Task create form — pure contract                                    */
/*                                                                     */
/* این repo jsdom ندارد (قید صفر وابستگی)، پس منطق فرم مثل              */
/* `planProposalView.test.ts` به‌صورت pure تست می‌شود، نه با رندر واقعی.    */
/* هدف: ثابت کردن اینکه «ارسال بدون دسته» در هیچ حالتی ممکن نیست.        */
/* ------------------------------------------------------------------ */

import { TASK_TITLE_MAX_LENGTH, TASK_TITLE_TOO_LONG_MESSAGE } from "@/app/lib/taskTitle"
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
            // preset بدون آیکن ارسال می‌شود؛ آیکن از واژگان canonical می‌آید
            if (r.ok) expect(r.category).toEqual({ category: c.key, categoryIcon: null })
        }
    })

    it("blocks submit when no category is selected", () => {
        const r = validateCreateForm("خرید نان", null)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toBe(CATEGORY_REQUIRED_MESSAGE)
    })

    it("blocks submit for a key outside the vocabulary", () => {
        // فراخوانی دوآرگومانی هیچ حالت customی فعال نمی‌کند، پس هیچ رشتهٔ آزادی
        // (حتی اگر برچسب معتبری باشد) از آن راه رد نمی‌شود.
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

    it("accepts a title exactly at the limit", () => {
        const r = validateCreateForm("ا".repeat(TASK_TITLE_MAX_LENGTH), "work")
        expect(r.ok).toBe(true)
    })

    it("blocks submit for a title over the limit with the shared message", () => {
        const r = validateCreateForm("ا".repeat(TASK_TITLE_MAX_LENGTH + 1), "work")
        expect(r.ok).toBe(false)
        if (!r.ok) {
            expect(r.field).toBe("title")
            expect(r.message).toBe(TASK_TITLE_TOO_LONG_MESSAGE)
        }
    })
})

describe("buildCreateTaskBody", () => {
    it("includes exactly title, scheduledDate and the selected category for a preset", () => {
        const body = buildCreateTaskBody("  خرید نان  ", SCHEDULED_DATE, "shopping")
        expect(body).toEqual({
            title: "خرید نان",
            scheduledDate: SCHEDULED_DATE,
            category: "shopping",
        })
        expect(Object.keys(body).sort()).toEqual(["category", "scheduledDate", "title"])
    })

    it("adds categoryIcon for a custom category", () => {
        const body = buildCreateTaskBody("طراحی سایت", SCHEDULED_DATE, "پروژه شخصی", "🚀")
        expect(body).toEqual({
            title: "طراحی سایت",
            scheduledDate: SCHEDULED_DATE,
            category: "پروژه شخصی",
            categoryIcon: "🚀",
        })
    })

    it("trims a custom label before sending it", () => {
        const body = buildCreateTaskBody("طراحی سایت", SCHEDULED_DATE, "  پروژه شخصی  ", "🚀")
        expect(body.category).toBe("پروژه شخصی")
    })

    it("never sends dayKey from the client (§6.2.2.1)", () => {
        const body = buildCreateTaskBody("کار", SCHEDULED_DATE, "work")
        expect(body).not.toHaveProperty("dayKey")
    })
})
