import { analyzeTask, type AiResult } from "@/app/lib/ai/analyzeTask"

const SAMPLES = [
    "گزارش فوری پروژه مشتری را آماده کن",
    "خرید نان از نانوایی",
    "تمرین زبان برای آزمون هفته بعد",
]

// اندپوینت تست AI — چند فراخوانی نمونه‌ی تحلیل (فقط کاربران واردشده)
export async function runAiSamples(): Promise<AiResult[]> {
    const results: AiResult[] = []
    for (const text of SAMPLES) {
        results.push(await analyzeTask(text))
    }
    return results
}