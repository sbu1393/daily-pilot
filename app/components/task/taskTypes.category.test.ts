import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* نمایش دسته در کارت تسک — از واژگان canonical مشتق می‌شود            */
/*                                                                     */
/* سه رفتار که قفل می‌شود:                                            */
/*  ۱) برای هر کلید canonical، آیکون + برچسب فارسی نمایش داده می‌شود      */
/*  ۲) دادهٔ legacy/ناشناخته UI را نمی‌شکند (fallback خنثی)            */
/*  ۳) هیچ نگاشت دومی برای TaskCard وجود ندارد                        */
/* ------------------------------------------------------------------ */

import { TASK_CATEGORIES, TASK_CATEGORY_KEYS } from "@/app/lib/categories"
import { categoryInfo } from "./taskTypes"

describe("categoryInfo — canonical categories", () => {
    it.each(TASK_CATEGORY_KEYS)("shows the icon and Persian label for %s", (key) => {
        const meta = TASK_CATEGORIES.find((c) => c.key === key)!
        const info = categoryInfo(key)
        expect(info.label).toBe(meta.label)
        expect(info.icon).toBe(meta.icon)
    })

    it("never renders the removed 'Urgent' category with a label", () => {
        // «Urgent» ممکن است در دادهٔ legacy باشد، اما نباید به‌عنوان دسته نمایش داده شود
        expect(categoryInfo("Urgent").label).toBe("Urgent") // خنثی، بدون آیکون
        expect(TASK_CATEGORY_KEYS as readonly string[]).not.toContain("Urgent")
    })
})

describe("categoryInfo — legacy and unknown data never crash the UI", () => {
    it.each([[null], [""], ["Work"], ["Personal"], ["Health"], ["universe"], ["خانه"]])(
        "falls back to a neutral style for %p",
        (value) => {
            const info = categoryInfo(value as string | null)
            expect(info.color).toBeTruthy()
            expect(info.bg).toBeTruthy()
            expect(info.label).toBeTruthy()
        },
    )

    it("shows the raw legacy string so the user can recognise and fix it", () => {
        expect(categoryInfo("Work").label).toBe("Work")
    })

    it("uses the neutral fallback (no icon) for null", () => {
        const info = categoryInfo(null)
        expect(info.label).toBe("بدون دسته")
        expect(info.icon).toBe("")
    })
})

describe("categoryInfo — custom categories show their own name and icon", () => {
    it("renders the stored label and icon", () => {
        const info = categoryInfo("پروژه شخصی", "🚀")
        expect(info.label).toBe("پروژه شخصی")
        expect(info.icon).toBe("🚀")
    })

    it("keeps the neutral colours — a custom category has no palette entry", () => {
        const info = categoryInfo("پروژه شخصی", "🚀")
        expect(info.color).toBeTruthy()
        expect(info.bg).toBeTruthy()
    })

    it("falls back to a safe icon when the stored one is missing", () => {
        expect(categoryInfo("پروژه شخصی").icon).toBe("🏷️")
        expect(categoryInfo("پروژه شخصی", null).icon).toBe("🏷️")
    })

    it("falls back to a safe icon when the stored one is not on the allowlist", () => {
        for (const bad of ["🦄", "", "<svg>"]) {
            expect(categoryInfo("پروژه شخصی", bad).icon).toBe("🏷️")
        }
    })

    it("ignores a stale icon on a preset row and still shows the vocabulary icon", () => {
        expect(categoryInfo("work", "🚀").icon).toBe("💼")
        expect(categoryInfo("home", null).icon).toBe("🏠")
    })

    it("gives legacy free text a safe icon instead of crashing", () => {
        expect(categoryInfo("Work").icon).toBe("🏷️")
        expect(categoryInfo("Work").label).toBe("Work")
    })

    it("stays neutral for null even when an icon is somehow present", () => {
        expect(categoryInfo(null, "🚀")).toEqual({
            label: "بدون دسته",
            icon: "",
            color: "#475467",
            bg: "#f2f4f7",
        })
    })
})
