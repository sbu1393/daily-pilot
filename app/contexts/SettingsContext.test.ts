import { describe, expect, it } from "vitest"
import { mergeSettings, DEFAULT_SETTINGS } from "./SettingsContext"

/* ------------------------------------------------------------------ */
/* M5 (Phase 2B) — Safe Parse & Merge برای dp:settings.                 */
/* این فایل pure است (بدون window/localStorage) و در محیط node تست می‌شود. */
/* سناریوها: JSON خراب، غیر-آبجکت، تیپ اشتباه هر کلید، و merge جزئی.    */
/* ------------------------------------------------------------------ */

describe("mergeSettings (M5 — Safe Parse & Merge)", () => {
    it("returns defaults for empty/null storage", () => {
        expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
        expect(mergeSettings("")).toEqual(DEFAULT_SETTINGS)
    })

    it("recovers with defaults from corrupted JSON (the crash point this fix removes)", () => {
        const corrupted = [
            "{ this is not json",
            '{"theme": "dark",,}',
            "not-json-at-all",
            '{"theme": }',
        ]
        for (const raw of corrupted) {
            expect(mergeSettings(raw)).toEqual(DEFAULT_SETTINGS)
        }
    })

    it("recovers with defaults for non-object JSON (numbers, arrays, strings)", () => {
        expect(mergeSettings("5")).toEqual(DEFAULT_SETTINGS)
        expect(mergeSettings("null")).toEqual(DEFAULT_SETTINGS)
        expect(mergeSettings('["dark"]')).toEqual(DEFAULT_SETTINGS)
        expect(mergeSettings('"dark"')).toEqual(DEFAULT_SETTINGS)
        expect(mergeSettings("true")).toEqual(DEFAULT_SETTINGS)
    })

    it("preserves valid keys and resets mistyped ones to defaults (partial merge)", () => {
        expect(
            mergeSettings(
                JSON.stringify({
                    theme: "dark",
                    sound: false,
                    reminderEnabled: true,
                    reminderTime: "07:30",
                }),
            ),
        ).toEqual({
            theme: "dark",
            sound: false,
            reminderEnabled: true,
            reminderTime: "07:30",
        })
    })

    it.each([
        ['{"theme": 42}', "theme: non-string"],
        ['{"theme": "neon"}', "theme: unknown value"],
        ['{"sound": "yes"}', "sound: non-boolean"],
        ['{"reminderEnabled": 1}', "reminderEnabled: non-boolean"],
        ['{"reminderTime": "7:30"}', "reminderTime: missing zero padding"],
        ['{"reminderTime": "99:99"}', "reminderTime: out of range shape"],
        ['{"reminderTime": 900}', "reminderTime: non-string"],
    ])("resets the default for %s", (raw) => {
        const merged = mergeSettings(raw)

        expect(merged.theme).toBe(DEFAULT_SETTINGS.theme)
        expect(merged.sound).toBe(DEFAULT_SETTINGS.sound)
        expect(merged.reminderEnabled).toBe(DEFAULT_SETTINGS.reminderEnabled)
        expect(merged.reminderTime).toBe(DEFAULT_SETTINGS.reminderTime)
    })

    it("keeps valid keys while only some keys are corrupted", () => {
        const merged = mergeSettings('{"theme": "light", "sound": "not-a-bool"}')

        expect(merged.theme).toBe("light") // کلید معتبر حفظ می‌شود
        expect(merged.sound).toBe(true) // کلید خراب → پیش‌فرض
        expect(merged.reminderEnabled).toBe(DEFAULT_SETTINGS.reminderEnabled)
        expect(merged.reminderTime).toBe(DEFAULT_SETTINGS.reminderTime)
    })

    it("accepts a valid HH:MM reminder time with leading zeros", () => {
        expect(mergeSettings('{"reminderTime": "21:05"}').reminderTime).toBe("21:05")
        expect(mergeSettings('{"reminderTime": "00:00"}').reminderTime).toBe("00:00")
    })
})
