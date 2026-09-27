import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* مرز HTTP برای دستهٔ تسک — preset در برابر custom                    */
/*                                                                     */
/* این لایه آخرین گارد نامعتبره: UI خودش اعتبارسنجی می‌کند، ولی بدنهٔ  */
/* API منبع غیرقابل‌اعتماد است و backend نباید به UI تکیه کند.        */
/* ------------------------------------------------------------------ */

import {
    CATEGORY_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_ICONS,
    CUSTOM_CATEGORY_ICON_INVALID_MESSAGE,
    CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_LABEL_MESSAGE,
    PRESET_ICON_FORBIDDEN_MESSAGE,
    TASK_CATEGORY_KEYS,
} from "@/app/lib/categories"
import { makeCreateTaskSchema, makeUpdateTaskSchema } from "./taskSchema"

const TZ = "Asia/Tehran"
const SCHEDULED_DATE = "2026-03-05T20:30:00.000Z"
const create = makeCreateTaskSchema(TZ)
const update = makeUpdateTaskSchema(TZ)

const base = { title: "خرید نان", scheduledDate: SCHEDULED_DATE }

describe("POST /api/tasks — preset selection", () => {
    it.each(TASK_CATEGORY_KEYS)("accepts the canonical key %s", (category) => {
        const r = create.safeParse({ ...base, category })
        expect(r.success).toBe(true)
        if (r.success) expect(r.data.category).toBe(category)
    })

    it("never stores an icon for a preset and rejects one that is sent", () => {
        const ok = create.safeParse({ ...base, category: "work" })
        expect(ok.success).toBe(true)

        const withIcon = create.safeParse({ ...base, category: "work", categoryIcon: "🚀" })
        expect(withIcon.success).toBe(false)
        if (!withIcon.success) {
            expect(JSON.stringify(withIcon.error.flatten())).toContain(PRESET_ICON_FORBIDDEN_MESSAGE)
        }
    })

    it.each([
        ["missing", {}],
        ["undefined", { category: undefined }],
        ["null", { category: null }],
        ["empty string", { category: "" }],
        ["whitespace only", { category: "   " }],
        ["wrong case", { category: "WORK" }],
        ["number", { category: 5 }],
    ])("rejects %s", (_label, extra) => {
        expect(create.safeParse({ ...base, ...extra }).success).toBe(false)
    })

    it("reports the shared required message for a missing category", () => {
        const r = create.safeParse(base)
        expect(r.success).toBe(false)
        if (!r.success) {
            expect(JSON.stringify(r.error.flatten())).toContain(CATEGORY_REQUIRED_MESSAGE)
        }
    })
})

describe("POST /api/tasks — custom selection", () => {
    it("accepts a user label with an allowlisted icon", () => {
        const r = create.safeParse({ ...base, category: "پروژه شخصی", categoryIcon: "🚀" })
        expect(r.success).toBe(true)
        if (r.success) expect(r.data.category).toBe("پروژه شخصی")
    })

    it("trims the label before handing it to the service", () => {
        const r = create.safeParse({ ...base, category: "  پروژه شخصی  ", categoryIcon: "🚀" })
        expect(r.success).toBe(true)
        if (r.success) expect(r.data.category).toBe("پروژه شخصی")
    })

    it("requires an icon", () => {
        const r = create.safeParse({ ...base, category: "پروژه شخصی" })
        expect(r.success).toBe(false)
        if (!r.success) {
            expect(JSON.stringify(r.error.flatten())).toContain(CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE)
        }
    })

    it("rejects an icon outside the allowlist", () => {
        for (const bad of ["🦄", "<svg>", "work", ""]) {
            const r = create.safeParse({ ...base, category: "پروژه شخصی", categoryIcon: bad })
            expect(r.success).toBe(false)
        }
        const r = create.safeParse({ ...base, category: "پروژه شخصی", categoryIcon: "🦄" })
        if (!r.success) {
            expect(JSON.stringify(r.error.flatten())).toContain(CUSTOM_CATEGORY_ICON_INVALID_MESSAGE)
        }
    })

    it.each(CUSTOM_CATEGORY_ICONS)("accepts the allowlisted icon %s", (icon) => {
        expect(create.safeParse({ ...base, category: "پروژه شخصی", categoryIcon: icon }).success).toBe(
            true,
        )
    })

    it.each([
        ["empty", ""],
        ["whitespace only", "   "],
        ["a single character", "ک"],
        ["longer than 50 characters", "ا".repeat(51)],
        ["markup", "<b>پروژه</b>"],
    ])("rejects a %s label", (_label, category) => {
        const r = create.safeParse({ ...base, category, categoryIcon: "🚀" })
        expect(r.success).toBe(false)
    })

    it("rejects a label that case-differs from a canonical key", () => {
        for (const category of ["work", "Work", "HEALTH"]) {
            expect(create.safeParse({ ...base, category, categoryIcon: "🚀" }).success).toBe(false)
        }
    })

    it("reports the length message for an out-of-range label", () => {
        const r = create.safeParse({ ...base, category: "ک", categoryIcon: "🚀" })
        expect(r.success).toBe(false)
        if (!r.success) {
            expect(JSON.stringify(r.error.flatten())).toContain(CUSTOM_CATEGORY_LABEL_MESSAGE)
        }
    })
})

describe("PATCH /api/tasks/[id] — category", () => {
    it.each(TASK_CATEGORY_KEYS)("accepts the canonical key %s", (category) => {
        expect(update.safeParse({ category }).success).toBe(true)
    })

    it("accepts null to clear the category", () => {
        expect(update.safeParse({ category: null }).success).toBe(true)
    })

    it("rejects null together with an icon", () => {
        expect(update.safeParse({ category: null, categoryIcon: "🚀" }).success).toBe(false)
    })

    it("accepts a preset → custom transition", () => {
        const r = update.safeParse({ category: "پروژه شخصی", categoryIcon: "💡" })
        expect(r.success).toBe(true)
    })

    it("accepts a custom → preset transition and rejects a leftover icon", () => {
        expect(update.safeParse({ category: "work" }).success).toBe(true)
        expect(update.safeParse({ category: "work", categoryIcon: "🚀" }).success).toBe(false)
    })

    it("rejects a custom category without an icon", () => {
        expect(update.safeParse({ category: "پروژه شخصی" }).success).toBe(false)
    })

    it("rejects an invalid custom icon", () => {
        expect(update.safeParse({ category: "پروژه شخصی", categoryIcon: "🦄" }).success).toBe(false)
    })

    it("rejects an icon sent without a category", () => {
        expect(update.safeParse({ categoryIcon: "🚀" }).success).toBe(false)
    })

    it("rejects an empty or whitespace-only category", () => {
        for (const bad of ["", "   ", 5]) {
            expect(update.safeParse({ category: bad }).success).toBe(false)
        }
    })

    it("still rejects an empty edit body", () => {
        expect(update.safeParse({}).success).toBe(false)
    })

    it("leaves the title/status/date rules untouched", () => {
        expect(update.safeParse({ title: "عنوان تازه" }).success).toBe(true)
        expect(update.safeParse({ status: "IN_PROGRESS" }).success).toBe(true)
        // DONE از مسیر اختصاصی /complete می‌آید، نه PATCH
        expect(update.safeParse({ status: "DONE" }).success).toBe(false)
        expect(update.safeParse({ title: "   " }).success).toBe(false)
        expect(update.safeParse({ scheduledDate: "2026-13-01" }).success).toBe(false)
    })
})
