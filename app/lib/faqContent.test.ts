import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* صفحهٔ پرسش‌های متداول — محتوا و منطق آکاردئون                       */
/*                                                                     */
/* این repo jsdom ندارد (قیدِ بدون وابستگی جدید)، پس منطقِ باز/بسته شدن */
/* در `faqContent.ts` خالص نگه داشته شده و همین‌جا تست می‌شود — دقیقاً */
/* همان الگوی `createTaskForm.test.ts` و `planProposalView.test.ts`.    */
/*                                                                     */
/* هدف: هر پاسخ باید کوتاه و خوانا بماند و هیچ سؤالی نباید بی‌پاسخ     */
/* یا تکراری باشد — محتوای راهنما اگر خراب شود کاربر را گمراه می‌کند.   */
/* ------------------------------------------------------------------ */

import { FAQ_ITEMS, findFaq, setAllFaq, toggleFaqId } from "./faqContent"

describe("FAQ content", () => {
    it("has between 15 and 20 questions, as promised to the user", () => {
        expect(FAQ_ITEMS.length).toBeGreaterThanOrEqual(15)
        expect(FAQ_ITEMS.length).toBeLessThanOrEqual(20)
    })

    it("gives every question a non-empty Persian question and answer", () => {
        for (const item of FAQ_ITEMS) {
            expect(item.question.trim()).toBe(item.question)
            expect(item.question.length).toBeGreaterThan(0)
            expect(item.answer.trim()).toBe(item.answer)
            expect(item.answer.length).toBeGreaterThan(0)
        }
    })

    it("keeps answers short enough to be scanned, not read", () => {
        for (const item of FAQ_ITEMS) {
            expect(item.answer.length).toBeLessThanOrEqual(600)
        }
    })

    it("uses unique ids — anchors and aria wiring depend on them", () => {
        const ids = FAQ_ITEMS.map((item) => item.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    it("uses url-safe ids so #<id> links work", () => {
        for (const item of FAQ_ITEMS) {
            expect(item.id).toMatch(/^[a-z0-9-]+$/)
        }
    })

    it("has no duplicate question text", () => {
        const questions = FAQ_ITEMS.map((item) => item.question)
        expect(new Set(questions).size).toBe(questions.length)
    })

    it("contains Persian script — the page is fully Persian", () => {
        const persian = /[؀-ۿ]/
        for (const item of FAQ_ITEMS) {
            expect(item.question).toMatch(persian)
            expect(item.answer).toMatch(persian)
        }
    })

    it("covers the topics the help page promises", () => {
        // کلیدواژه‌هایی که موضوعات اصلی راهنما را نگه می‌دارند؛ اگر پاسخی
        // حذف یا بازنویسی شد و این موضوع دیگر پوشش داده نشد، تست می‌افتد.
        const corpus = FAQ_ITEMS.map((item) => item.question + " " + item.answer).join(" ")
        for (const topic of [
            "سفارشی",
            "دسته‌بندی",
            "برنامهٔ روزانه",
            "یادآوری",
            "آفلاین",
            "ویرایش",
            "حذف",
        ]) {
            expect(corpus).toContain(topic)
        }
    })

    it("does not advertise the custom-category icon as optional", () => {
        const icon = findFaq("custom-category-icon")
        expect(icon).toBeDefined()
        expect(icon!.answer).toContain("آیکن")
    })

    it("findFaq resolves a known id and returns undefined for a missing one", () => {
        expect(findFaq("what-is")?.question).toBe(FAQ_ITEMS[0].question)
        expect(findFaq("no-such-id")).toBeUndefined()
    })
})

describe("toggleFaqId — the accordion's only state rule", () => {
    it("opens a closed item", () => {
        expect(toggleFaqId([], "a")).toEqual(["a"])
    })

    it("closes an open item — clicking the same question again closes it", () => {
        expect(toggleFaqId(["a"], "a")).toEqual([])
    })

    it("keeps other items open, so more than one can be open at a time", () => {
        expect(toggleFaqId(["a"], "b")).toEqual(["a", "b"])
    })

    it("closes only the clicked item when several are open", () => {
        expect(toggleFaqId(["a", "b", "c"], "b")).toEqual(["a", "c"])
    })

    it("does not mutate the previous array", () => {
        const before = ["a"]
        toggleFaqId(before, "b")
        expect(before).toEqual(["a"])
    })

    it("ignores an unknown id on close, so a stale id cannot empty the list", () => {
        expect(toggleFaqId(["a"], "zzz")).toEqual(["a", "zzz"])
    })
})

describe("setAllFaq — the open/close-all control", () => {
    it("opens every item", () => {
        expect(setAllFaq(FAQ_ITEMS, true)).toEqual(FAQ_ITEMS.map((i) => i.id))
    })

    it("closes every item", () => {
        expect(setAllFaq(FAQ_ITEMS, false)).toEqual([])
    })

    it("round-trips with toggleFaqId on a real id", () => {
        const all = setAllFaq(FAQ_ITEMS, true)
        const first = FAQ_ITEMS[0].id
        expect(toggleFaqId(all, first)).toEqual(all.filter((id) => id !== first))
    })
})
