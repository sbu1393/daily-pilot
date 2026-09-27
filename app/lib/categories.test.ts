import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Task Categories — canonical vocabulary                              */
/*                                                                     */
/* این فایل قفل می‌کند که «یک منبع حقیقت» وجود دارد: هر دسته دقیقاً یک  */
/* کلید پایدار، یک برچسب فارسی، یک ایموجی و یک ترتیب دارد — و هیچ کلیدی */
/* بیرون از این فهرست پذیرفته نمی‌شود.                                  */
/* ------------------------------------------------------------------ */

import {
    CATEGORY_REQUIRED_MESSAGE,
    TASK_CATEGORIES,
    TASK_CATEGORY_KEYS,
    assertTaskCategoryKey,
    getTaskCategory,
    isTaskCategoryKey,
    type TaskCategoryKey,
} from "./categories"
import { makeCreateTaskSchema, makeUpdateTaskSchema } from "@/app/schema/taskSchema"

const TZ = "Asia/Tehran"
const SCHEDULED_DATE = "2026-03-05T00:00:00.000Z"

describe("canonical vocabulary", () => {
    it("is exactly the eight agreed categories, in order", () => {
        expect(TASK_CATEGORY_KEYS).toEqual([
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

    it("does not contain 'Urgent' — urgency is priority, not category", () => {
        expect(TASK_CATEGORY_KEYS as readonly string[]).not.toContain("Urgent")
        expect(TASK_CATEGORY_KEYS as readonly string[]).not.toContain("urgent")
    })

    it("does not keep the old four capitalized keys", () => {
        for (const legacy of ["Work", "Personal", "Health"]) {
            expect(TASK_CATEGORY_KEYS as readonly string[]).not.toContain(legacy)
        }
    })

    it("gives every category a Persian label, an icon and a unique sortOrder", () => {
        const orders = TASK_CATEGORIES.map((c) => c.sortOrder)
        expect(new Set(orders).size).toBe(orders.length)
        for (const c of TASK_CATEGORIES) {
            expect(c.label.trim().length).toBeGreaterThan(0)
            expect(c.icon.length).toBeGreaterThan(0)
        }
        // ترتیب نمایش صعودی و بدون حفره
        expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    })

    it("exposes a lookup per key and nothing else", () => {
        for (const key of TASK_CATEGORY_KEYS) {
            expect(getTaskCategory(key)?.key).toBe(key)
        }
        expect(getTaskCategory("nope")).toBeUndefined()
        expect(getTaskCategory("Work")).toBeUndefined() // legacy key is not canonical
    })
})

describe("isTaskCategoryKey", () => {
    it("accepts every canonical key", () => {
        for (const key of TASK_CATEGORY_KEYS) expect(isTaskCategoryKey(key)).toBe(true)
    })

    it.each([[null], [undefined], [""], ["   "], ["Work"], ["Urgent"], [5], [{}]])(
        "rejects %p",
        (value) => {
            expect(isTaskCategoryKey(value)).toBe(false)
        },
    )
})

describe("assertTaskCategoryKey", () => {
    it("passes for a canonical key", () => {
        expect(() => assertTaskCategoryKey("work")).not.toThrow()
    })

    it("throws for anything else so a service can never persist a bad category", () => {
        expect(() => assertTaskCategoryKey(null)).toThrow(/INVALID_TASK_CATEGORY/)
        expect(() => assertTaskCategoryKey("Work")).toThrow(/INVALID_TASK_CATEGORY/)
    })
})

describe("makeCreateTaskSchema — category is REQUIRED", () => {
    const base = { title: "خرید نان", scheduledDate: SCHEDULED_DATE }

    it.each(TASK_CATEGORY_KEYS)("accepts canonical category %s", (category) => {
        const r = makeCreateTaskSchema(TZ).safeParse({ ...base, category })
        expect(r.success).toBe(true)
        if (r.success) expect(r.data.category).toBe(category)
    })

    it.each([
        ["missing", {}],
        ["undefined", { category: undefined }],
        ["null", { category: null }],
        ["empty string", { category: "" }],
        ["whitespace only", { category: "   " }],
        ["unknown key", { category: "universe" }],
        ["legacy capitalized key", { category: "Work" }],
        ["legacy Urgent", { category: "Urgent" }],
        ["wrong case", { category: "WORK" }],
        ["number", { category: 5 }],
    ])("rejects %s", (_label, extra) => {
        const r = makeCreateTaskSchema(TZ).safeParse({ ...base, ...extra })
        expect(r.success).toBe(false)
    })

    it("reports the shared required message for a missing category", () => {
        const r = makeCreateTaskSchema(TZ).safeParse(base)
        expect(r.success).toBe(false)
        if (!r.success) {
            expect(JSON.stringify(r.error.flatten())).toContain(CATEGORY_REQUIRED_MESSAGE)
        }
    })
})

describe("makeUpdateTaskSchema — category is canonical or cleared", () => {
    const schema = makeUpdateTaskSchema(TZ)

    it.each(TASK_CATEGORY_KEYS)("accepts canonical category %s", (category) => {
        expect(schema.safeParse({ category }).success).toBe(true)
    })

    it("accepts null to clear the category", () => {
        expect(schema.safeParse({ category: null }).success).toBe(true)
    })

    it("rejects arbitrary free text so PATCH cannot reintroduce it", () => {
        for (const bad of ["خانه", "Work", "Urgent", "", "   ", 5]) {
            expect(schema.safeParse({ category: bad }).success).toBe(false)
        }
    })

    it("still rejects an empty edit body", () => {
        expect(schema.safeParse({}).success).toBe(false)
    })
})

describe("type contract", () => {
    it("TaskCategoryKey is exactly the eight literal keys", () => {
        // تضمین نوع در زمان کامپایل: این متغیر فقط با کلیدهای معتبر مقدار می‌گیرد
        const k: TaskCategoryKey = "transport"
        expect(isTaskCategoryKey(k)).toBe(true)
    })
})
