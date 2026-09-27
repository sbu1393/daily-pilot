import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* دستهٔ سفارشی — pure form contract                                  */
/*                                                                     */
/* presetها canonical و ثابت می‌مانند؛ custom یک برچسب آزاد + یک آیکن */
/* از allowlist است. این repo jsdom ندارد، پس کل منطق اینجا تست می‌شود. */
/* ------------------------------------------------------------------ */

import {
    CUSTOM_CATEGORY_ICONS,
    CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_LABEL_MESSAGE,
    CUSTOM_CATEGORY_RESERVED_MESSAGE,
} from "@/app/lib/categories"
import {
    EMPTY_CATEGORY_DRAFT,
    OTHER_CATEGORY_LABEL,
    draftFromSelection,
    selectCustom,
    selectPreset,
    validateCategoryDraft,
    type CategoryDraft,
} from "./categoryForm"

const custom = (label: string, icon: string | null): CategoryDraft => ({
    mode: "custom",
    preset: null,
    customLabel: label,
    customIcon: icon,
})

describe("the allowlist is a small, fixed, non-empty set", () => {
    it("exposes icons a user can actually pick", () => {
        expect(CUSTOM_CATEGORY_ICONS.length).toBeGreaterThanOrEqual(8)
        expect(CUSTOM_CATEGORY_ICONS.length).toBeLessThanOrEqual(32)
    })

    it("contains no duplicates", () => {
        expect(new Set(CUSTOM_CATEGORY_ICONS).size).toBe(CUSTOM_CATEGORY_ICONS.length)
    })

    it("has no whitespace-only or empty entry", () => {
        for (const icon of CUSTOM_CATEGORY_ICONS) expect(icon.trim()).toBe(icon)
    })
})

describe("validateCategoryDraft — preset", () => {
    it("returns the canonical key with a null icon", () => {
        const r = validateCategoryDraft({
            mode: "preset",
            preset: "work",
            customLabel: "",
            customIcon: null,
        })
        expect(r).toEqual({ ok: true, selection: { category: "work", categoryIcon: null } })
    })

    it("blocks an unselected or forged preset", () => {
        for (const preset of [null, "", "Work", "universe"]) {
            const r = validateCategoryDraft({
                mode: "preset",
                preset,
                customLabel: "",
                customIcon: null,
            })
            expect(r.ok).toBe(false)
        }
    })

    it("never carries a custom icon back into a preset", () => {
        // selectPreset پاک‌سازی می‌کند، ولی حتی با draft دستکاری‌شده هم آیکن نمی‌رود
        const r = validateCategoryDraft({
            mode: "preset",
            preset: "home",
            customLabel: "پروژه شخصی",
            customIcon: "🚀",
        })
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.selection.categoryIcon).toBeNull()
    })
})

describe("validateCategoryDraft — custom label", () => {
    it("accepts a trimmed Persian label with an allowlisted icon", () => {
        const r = validateCategoryDraft(custom("  پروژه شخصی  ", "🚀"))
        expect(r).toEqual({
            ok: true,
            selection: { category: "پروژه شخصی", categoryIcon: "🚀" },
        })
    })

    it("accepts an English label too — the vocabulary is not Persian-only", () => {
        const r = validateCategoryDraft(custom("Side project", "💡"))
        expect(r.ok).toBe(true)
    })

    it.each([
        ["empty", ""],
        ["whitespace only", "    "],
        ["a single character", "ک"],
    ])("rejects a %s label", (_label, value) => {
        const r = validateCategoryDraft(custom(value, "🚀"))
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toBe(CUSTOM_CATEGORY_LABEL_MESSAGE)
    })

    it("rejects a label longer than 50 characters", () => {
        const r = validateCategoryDraft(custom("ا".repeat(51), "🚀"))
        expect(r.ok).toBe(false)
    })

    it("accepts a label of exactly 50 characters", () => {
        const r = validateCategoryDraft(custom("ا".repeat(50), "🚀"))
        expect(r.ok).toBe(true)
    })

    it("rejects markup in the label", () => {
        for (const bad of ["<b>پروژه</b>", "پروژه<script>", "a>b"]) {
            const r = validateCategoryDraft(custom(bad, "🚀"))
            expect(r.ok).toBe(false)
        }
    })

    it("rejects a label that only case-differs from a canonical key", () => {
        for (const bad of ["work", "Work", "WORK", " Health "]) {
            const r = validateCategoryDraft(custom(bad, "🚀"))
            expect(r.ok).toBe(false)
            if (!r.ok) expect(r.message).toBe(CUSTOM_CATEGORY_RESERVED_MESSAGE)
        }
    })
})

describe("validateCategoryDraft — custom icon", () => {
    it("requires an icon", () => {
        const r = validateCategoryDraft(custom("پروژه شخصی", null))
        expect(r.ok).toBe(false)
        if (!r.ok) {
            expect(r.message).toBe(CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE)
            expect(r.field).toBe("customIcon")
        }
    })

    it("rejects any icon outside the allowlist", () => {
        for (const bad of ["🦄", "", "<svg>", "work", "🚀🚀"]) {
            const r = validateCategoryDraft(custom("پروژه شخصی", bad))
            expect(r.ok).toBe(false)
            if (!r.ok) expect(r.field).toBe("customIcon")
        }
    })

    it.each(CUSTOM_CATEGORY_ICONS)("accepts %s from the allowlist", (icon) => {
        expect(validateCategoryDraft(custom("پروژه شخصی", icon)).ok).toBe(true)
    })
})

describe("switching modes", () => {
    it("clears any custom draft when the user picks a preset", () => {
        const draft = selectPreset("work")
        expect(draft).toEqual({ mode: "preset", preset: "work", customLabel: "", customIcon: null })
    })

    it("keeps what the user already typed when they come back to custom", () => {
        const draft = selectCustom(custom("پروژه شخصی", "🚀"))
        expect(draft.mode).toBe("custom")
        expect(draft.customLabel).toBe("پروژه شخصی")
        expect(draft.customIcon).toBe("🚀")
    })

    it("starts empty when entering custom for the first time", () => {
        expect(selectCustom()).toEqual({
            mode: "custom",
            preset: null,
            customLabel: "",
            customIcon: null,
        })
    })

    it("ignores a non-canonical key passed to selectPreset", () => {
        expect(selectPreset("universe")).toEqual(EMPTY_CATEGORY_DRAFT)
    })

    it("has a Persian label for the custom entry point", () => {
        expect(OTHER_CATEGORY_LABEL).toBe("دسته‌بندی دیگر")
    })
})

describe("draftFromSelection — populating the edit form from a stored task", () => {
    it("selects the preset for a canonical category and never sets an icon", () => {
        const draft = draftFromSelection("work", null)
        expect(draft).toEqual({ mode: "preset", preset: "work", customLabel: "", customIcon: null })
    })

    it("ignores a stored icon on a preset row (legacy/corrupt data cannot break the form)", () => {
        expect(draftFromSelection("work", "🚀")).toEqual({
            mode: "preset",
            preset: "work",
            customLabel: "",
            customIcon: null,
        })
    })

    it("opens in custom mode with the name and icon populated for a custom task", () => {
        expect(draftFromSelection("پروژه شخصی", "🚀")).toEqual({
            mode: "custom",
            preset: null,
            customLabel: "پروژه شخصی",
            customIcon: "🚀",
        })
    })

    it("trims the stored label", () => {
        expect(draftFromSelection("  پروژه شخصی  ", "🚀").customLabel).toBe("پروژه شخصی")
    })

    it("clears an icon that is not on the allowlist so the user must re-pick", () => {
        const draft = draftFromSelection("پروژه شخصی", "🦄")
        expect(draft.mode).toBe("custom")
        expect(draft.customIcon).toBeNull()
    })

    it("never crashes on null or on legacy free text", () => {
        expect(draftFromSelection(null)).toEqual(EMPTY_CATEGORY_DRAFT)
        expect(draftFromSelection(undefined, "🚀")).toEqual(EMPTY_CATEGORY_DRAFT)
        expect(draftFromSelection("")).toEqual(EMPTY_CATEGORY_DRAFT)
        expect(draftFromSelection("Work")).toEqual(EMPTY_CATEGORY_DRAFT)
        // legacy «خانه» هنوز یک برچسب معتبر است، پس برای اصلاح در حالت custom باز می‌شود
        expect(draftFromSelection("خانه").mode).toBe("custom")
    })

    it("round-trips: a stored selection reproduces an identical valid draft", () => {
        for (const [category, icon] of [
            ["work", null],
            ["پروژه شخصی", "🚀"],
        ] as const) {
            const draft = draftFromSelection(category, icon)
            const r = validateCategoryDraft(draft)
            expect(r.ok).toBe(true)
            if (r.ok) expect(r.selection).toEqual({ category, categoryIcon: icon })
        }
    })
})
