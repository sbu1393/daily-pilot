// AI tests — pin کردن قطعی محیط provider
//
// چرا این فایل وجود دارد
// ----------------------
// `analyzeTask` / `analyzeBatchPlan` در سطح ماژول `AI_MAX_ATTEMPTS`،
// `AI_ALLOW_FALLBACK` و کلیدهای provider را می‌خوانند و `resolveProviderChain`
// بر اساس *وجود کلید fallback* اعضای زنجیره را می‌سازد. یعنی «تعداد تلاش‌ها» که
// تست‌ها assert می‌کنند مستقیماً به محیط اجرا وابسته است.
//
// delete کردن env در `vi.hoisted` به‌تنهایی کافی نبود: `vi.stubEnv` در vitest
// snapshot محیط را بازیابی می‌کند، پس `AI_ALLOW_FALLBACK` و `AIXAI_API_KEY` که از
// `.env` سندباکس آمده بودند دوباره ظاهر می‌شدند، زنجیره دو-عضوی می‌شد و `fetch`
// سه بار به‌جای دو بار صدا زده می‌شد — یعنی نتیجهٔ تست به فایل `.env` ماشین وابسته
// بود (بعضی اجراها سبز، بعضی قرمز).
//
// راه‌حل: به‌جای تکیه بر delete، مقادیر را با خودِ `vi.stubEnv` **قفل** می‌کنیم تا
// هر بازیابیِ بعدی بی‌اثر بماند، و در `afterEach` هم به‌درستی برمی‌گردند.

import { vi } from "vitest"

/**
 * محیط provider را به وضعیت قطعی می‌برد. در `beforeEach` هر describe صدا زده می‌شود.
 *
 * مقادیر عمداً **غیرتعریف/ falsy** هستند، نه `delete`:
 *   • `AI_ALLOW_FALLBACK = "false"`  → `isAiFallbackEnabled()` (که فقط `"true"` را
 *     قبول می‌کند) خاموش می‌ماند، پس زنجیره تک‌عضوی است.
 *   • `AIXAI_API_KEY = ""`           → `isConfigured()` false، حتی اگر بعداً
 *    _snapshot_ محیط دوباره پر شود.
 *
 * `OPENROUTER_API_KEY` عمداً دست‌نخورده است: خودِ تست‌ها تعیین می‌کنند کلید هست یا نه.
 */
export function pinProviderEnv(): void {
    vi.stubEnv("AI_MAX_ATTEMPTS", "2")
    vi.stubEnv("AI_TIMEOUT_MS", "3000")
    vi.stubEnv("AI_FALLBACK_MAX_ATTEMPTS", "1")
    // قفل‌های ضد-نشت — این دو باید در پایان اعمال شوند تا اگر بازیابیِ محیط در
    // فراخوانی‌های قبلی رخ داده باشد، همین‌ها آخرین حرف را بزنند.
    vi.stubEnv("AI_ALLOW_FALLBACK", "false")
    vi.stubEnv("AIXAI_API_KEY", "")
}
