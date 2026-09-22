import { describe, expect, it } from "vitest"
import {
    isReminderFired,
    loadReminderFiredKeys,
    markReminderFired,
    MAX_REMINDER_FIRED_KEYS,
    REMINDER_FIRED_NAMESPACE,
    REMINDER_FIRED_STORAGE_KEY,
    reminderFiredKey,
    type FiredKeyStorage,
} from "./reminderFired"

/* ------------------------------------------------------------------ */
/* ADR-07 فاز ۴-A — namespace مشترک کلیدهای «اجرا شد».                 */
/* محیط node بدون DOM؛ storage تزریق‌پذیر است (بدون وابستگی جدید).      */
/* ------------------------------------------------------------------ */

function makeStorage(initial: Record<string, string> = {}) {
    const data: Record<string, string> = { ...initial }
    const storage: FiredKeyStorage & { raw: Record<string, string> } = {
        raw: data,
        getItem: (key: string) =>
            Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null,
        setItem: (key: string, value: string) => {
            data[key] = value
        },
    }
    return storage
}

describe("reminderFiredKey", () => {
    it("builds the historical `${taskId}@${reminderAt}` key", () => {
        expect(reminderFiredKey(42, "2026-09-22T09:30:00.000Z")).toBe(
            "42@2026-09-22T09:30:00.000Z",
        )
    })

    it("keeps a distinct key for a reminder without an instant", () => {
        expect(reminderFiredKey(7, null)).toBe("7@")
        expect(reminderFiredKey(7, undefined)).toBe("7@")
    })

    it("produces a NEW key when reminderAt changes (edit → one new notification)", () => {
        expect(reminderFiredKey(5, "2026-09-22T09:30:00.000Z")).not.toBe(
            reminderFiredKey(5, "2026-09-22T10:00:00.000Z"),
        )
    })

    it("keeps the existing storage key and namespace (watcher/reconciler/push share it)", () => {
        expect(REMINDER_FIRED_STORAGE_KEY).toBe("dp:task-reminder-fired:v1")
        expect(REMINDER_FIRED_NAMESPACE).toBe("task-reminder")
    })
})

describe("loadReminderFiredKeys", () => {
    it("returns an empty set when nothing is stored", () => {
        expect(loadReminderFiredKeys(makeStorage()).size).toBe(0)
    })

    it("reads the stored keys", () => {
        const storage = makeStorage({ [REMINDER_FIRED_STORAGE_KEY]: '["1@a","2@b"]' })

        expect(Array.from(loadReminderFiredKeys(storage))).toEqual(["1@a", "2@b"])
    })

    it.each([
        ["corrupt JSON", "{not json"],
        ["non-array payload", '{"a":1}'],
    ])("falls back to an empty set for %s", (_label, raw) => {
        expect(loadReminderFiredKeys(makeStorage({ [REMINDER_FIRED_STORAGE_KEY]: raw })).size).toBe(0)
    })

    it("drops non-string entries", () => {
        const storage = makeStorage({ [REMINDER_FIRED_STORAGE_KEY]: '["1@a",3,null,{"x":1}]' })

        expect(Array.from(loadReminderFiredKeys(storage))).toEqual(["1@a"])
    })

    it("never throws in a non-browser environment (no localStorage)", () => {
        expect(loadReminderFiredKeys().size).toBe(0)
        expect(loadReminderFiredKeys(null).size).toBe(0)
    })
})

describe("markReminderFired", () => {
    it("records a key once and reports duplicates by returning false", () => {
        const storage = makeStorage()

        expect(markReminderFired("1@a", storage)).toBe(true)
        expect(markReminderFired("1@a", storage)).toBe(false)
        expect(loadReminderFiredKeys(storage).size).toBe(1)
        expect(isReminderFired("1@a", storage)).toBe(true)
        expect(isReminderFired("2@b", storage)).toBe(false)
    })

    it("re-reads storage before writing so a second tab does not duplicate work", () => {
        const shared = makeStorage()
        expect(markReminderFired("9@x", shared)).toBe(true)
        // «تب دوم» همان storage را می‌بیند → کلید قبلاً ثبت شده است
        expect(markReminderFired("9@x", shared)).toBe(false)
    })

    it(`keeps at most ${MAX_REMINDER_FIRED_KEYS} keys (bounded localStorage usage)`, () => {
        const storage = makeStorage()

        for (let i = 0; i < MAX_REMINDER_FIRED_KEYS + 40; i += 1) {
            markReminderFired(`${i}@t`, storage)
        }

        const keys = Array.from(loadReminderFiredKeys(storage))
        expect(keys.length).toBe(MAX_REMINDER_FIRED_KEYS)
        expect(keys[keys.length - 1]).toBe(`${MAX_REMINDER_FIRED_KEYS + 39}@t`)
    })

    it("is fail-open when setItem throws (quota/disabled storage)", () => {
        const throwing: FiredKeyStorage = {
            getItem: () => null,
            setItem: () => {
                throw new Error("QuotaExceededError")
            },
        }

        expect(markReminderFired("1@a", throwing)).toBe(true)
        expect(loadReminderFiredKeys(throwing).size).toBe(0)
    })

    it("does not throw without any storage available", () => {
        expect(() => markReminderFired("1@a")).not.toThrow()
        expect(markReminderFired("1@a")).toBe(true)
    })
})
