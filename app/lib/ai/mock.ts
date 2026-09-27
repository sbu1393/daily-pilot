import type { AiAnalysis } from "./aiSchema"
import type { TaskCategoryKey } from "@/app/lib/categories"

const URGENT_WORDS = ["فوری", "الان", "همین حالا", "مهم", "بحرانی", "اضطراری", "مهلت", "دکتر", "بیمارستان", "سررسید", "deadline"]
const LONG_WORDS = ["پروژه", "گزارش", "تحقیق", "مقاله", "طراحی", "برنامه‌نویسی", "بازبینی", "مطالعه", "آموزش", "توسعه", "تحلیل", "جلسه", "مذاکره", "تدوین"]
const QUICK_WORDS = ["خرید", "تماس", "ایمیل", "پیام", "پاسخ", "یادآوری", "هماهنگی", "نوبت"]
const HEALTH_WORDS = ["دکتر", "بیمارستان", "دارو", "ورزش", "سلامت", "خواب", "رژیم", "آزمایش"]
const WORK_WORDS = ["کار", "پروژه", "گزارش", "مشتری", "جلسه", "اداری", "رزومه", "مصاحبه", "تحویل"]
// دسته‌های mock از همان واژگان canonical دسته‌بندی تسک می‌آیند (بدون Urgent:
// فوریت در priority/score است، نه در دسته‌بندی).
const HOME_WORDS = ["خانه", "جارو", "شست‌وشو", "ظرف", "لباس", "اتاق", "میز", "نظافت"]
const TRANSPORT_WORDS = ["ماشین", "خودرو", "رفت‌وآمد", "سفر", "بنزین", "تعمیرگاه", "اسنپ", "تاکسی"]
const SHOPPING_WORDS = ["خرید", "سوپرمارکت", "فروشگاه", "مغازه", "نان", "میوه", "اقلام"]
const LEARNING_WORDS = ["یادگیری", "درس", "کتاب", "آموزش", "زبان", "تمرین", "دوره"]
const LEISURE_WORDS = ["تفریح", "بازی", "فیلم", "موسیقی", "سفر", "استراحت", "کافه"]

function hashText(text: string): number {
    let h = 0
    for (let i = 0; i < text.length; i++) {
        h = (h << 5) - h + text.charCodeAt(i)
        h |= 0
    }
    return Math.abs(h)
}

function hasAny(text: string, words: string[]) {
    return words.some((w) => text.includes(w))
}

export function mockAnalyze(text: string): AiAnalysis {
    const t = text.trim()
    const urgent = hasAny(t, URGENT_WORDS)
    const isLong = hasAny(t, LONG_WORDS)
    const isQuick = hasAny(t, QUICK_WORDS)

    const hash = hashText(t)

    // امتیاز اهمیت (همون متن → همون عدد، برای تست پایداره)
    let score = 55 + (hash % 30)
    if (urgent) score += 12
    if (isLong) score += 4
    score = Math.min(96, score)

    // تخمین زمان
    let estimatedMinutes: number
    if (isQuick) estimatedMinutes = 10 + (hash % 21)               // ۱۰ تا ۳۰
    else if (isLong) estimatedMinutes = 60 + (hash % 4) * 30       // ۶۰ تا ۱۵۰
    else estimatedMinutes = 15 + (hash % 5) * 10 + t.split(/\s+/).length * 3
    estimatedMinutes = Math.min(240, Math.max(10, estimatedMinutes))

    const priority: AiAnalysis["priority"] =
        urgent || score >= 80 ? "HIGH" : score >= 60 ? "MEDIUM" : "LOW"

    // ترتیب بررسی ثابت است تا mock قطعی بماند؛ هر مسیر یک کلید canonical برمی‌گرداند
    let category: TaskCategoryKey = "personal"
    if (hasAny(t, WORK_WORDS)) category = "work"
    else if (hasAny(t, HEALTH_WORDS)) category = "health"
    else if (hasAny(t, LEARNING_WORDS)) category = "learning"
    else if (hasAny(t, TRANSPORT_WORDS)) category = "transport"
    else if (hasAny(t, SHOPPING_WORDS)) category = "shopping"
    else if (hasAny(t, LEISURE_WORDS)) category = "leisure"
    else if (hasAny(t, HOME_WORDS)) category = "home"

    let reason: string
    if (urgent)
        reason = "این کار حساسیت زمانی بالایی دارد؛ تأخیر در آن هزینه ایجاد می‌کند پس اولویت بالا گرفت."
    else if (isLong && score >= 70)
        reason = "زمان‌بر است و روی اهداف اصلی روز اثر می‌گذارد؛ بهتر است اوایل روز انجام شود."
    else if (isQuick)
        reason = "کار کوتاهی است و می‌تواند در فاصله‌های آزاد روز انجام شود."
    else
        reason = "بر اساس پیچیدگی و اهمیت عنوان، این بازه و اولویت پیشنهاد شد."

    return { priority, score, estimatedMinutes, reason, category }
}
