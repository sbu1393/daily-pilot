import { describe, expect, it } from "vitest"

import { planNativeReminders } from "@/app/lib/native/reminderPlan"
import type { TaskReminder } from "@/app/lib/taskReminder"

/*
 * برنامه‌ی زمان‌بندی/لغو یادآورهای نیتیو.
 *
 * مهم‌ترین ادعای این فایل، رگرسیون زیر است:
 *   «یادآورِ اجراشده نباید لغو شود.»
 *
 * اگر کسی دوباره `firedAt !== null` را از مجموعه‌ی مطلوب‌ها بیرون بگذارد،
 * اعلانِ در انتظار روی دستگاه پیش از رسیدن لغو می‌شود و این تست شکست می‌خورد.
 */

function reminder(taskId: number, overrides: Partial<TaskReminder> = {}): TaskReminder {
    return {
        taskId,
        title: `تسک ${taskId}`,
        dueAt: 1_000_000,
        createdAt: 0,
        firedAt: null,
        ...overrides,
    }
}

describe("planNativeReminders", () => {
    it("یادآور اجرانشده‌ی تازه ⇒ زمان‌بندی، بدون هیچ لغو", () => {
        const plan = planNativeReminders([reminder(7)], [])

        expect(plan.toSchedule).toEqual([7])
        expect(plan.stale).toEqual([])
    })

    it("یادآور اجراشده ⇒ دیگر زمان‌بندی نمی‌شود ولی **لغو هم نمی‌شود**", () => {
        const plan = planNativeReminders([reminder(7, { firedAt: 2_000_000 })], [7])

        expect(plan.toSchedule).toEqual([])
        expect(plan.stale).toEqual([])
    })

    it("یادآور حذف‌شده از لیست ⇒ لغو می‌شود", () => {
        const plan = planNativeReminders([], [9])

        expect(plan.toSchedule).toEqual([])
        expect(plan.stale).toEqual([9])
    })

    it("هم یادآور حذف‌شده و هم یادآورِ اجراشده: فقط حذف‌شده لغو می‌شود", () => {
        const plan = planNativeReminders(
            [reminder(1), reminder(2, { firedAt: 5_000 })],
            [1, 2, 3],
        )

        expect(plan.toSchedule).toEqual([1])
        expect(plan.stale).toEqual([3])
    })

    /*
     * زمان‌بندی عمداً idempotent است: هر یادآورِ اجرانشده در هر تغییر لیست دوباره
     * به پل داده می‌شود (شناسه قطعی است، پس همان اعلان جایگزین می‌شود). این کار
     * جلوی «از دست رفتن آلارم» را می‌گیرد. پس «قبلاً زمان‌بندی شده» به‌تنهایی
     * دلیل حذف از `toSchedule` نیست؛ فقط «اجرا شده» هست.
     */
    it("یادآور اجرانشده دوباره زمان‌بندی می‌شود، اجراشده نه — و هیچ لغوی نیست", () => {
        const plan = planNativeReminders(
            [reminder(1), reminder(2, { firedAt: 5_000 })],
            [1, 2],
        )

        expect(plan.toSchedule).toEqual([1])
        expect(plan.stale).toEqual([])
    })

    it("تغییر زمان یادآور (firedAt صفر شده) ⇒ دوباره زمان‌بندی می‌شود", () => {
        const plan = planNativeReminders([reminder(4, { firedAt: null })], [4])

        expect(plan.toSchedule).toEqual([4])
        expect(plan.stale).toEqual([])
    })

    it("ترتیب زمان‌بندی همان ترتیب لیست است (ترتیب پل قطعی می‌ماند)", () => {
        const plan = planNativeReminders([reminder(30), reminder(10), reminder(20)], [])

        expect(plan.toSchedule).toEqual([30, 10, 20])
    })

    it("شناسه‌های تکراری در scheduled باعث لغو تکراری نمی‌شوند (Set ورودی)", () => {
        const plan = planNativeReminders([reminder(1)], new Set([1, 1, 2]))

        expect(plan.stale).toEqual([2])
    })
})
