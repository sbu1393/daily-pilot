"use client"

import { faDigits, fmtMinutes } from "@/app/lib/time"
import { type AdvisorResult } from "@/app/lib/planner/advisor"
import { type SuggestionData } from "@/app/hooks/useDaySuggestion"
import { type TaskItem } from "./taskTypes"
import taskStyles from "./task.module.css"
import styles from "./advisor.module.css"
import { Coffee, HourglassCog, ShelvingUnit, Sprout, TimerReset, TriangleAlert } from "lucide-react"

/* ------------------------------------------------------------------ */
/* AdvisorCard — کارتِ مشاور روی نمای روز.                             */
/*                                                                    */
/* دو منبع داده، یک کارت:                                             */
/* ۱) «کار بعدی» — از GET /api/tasks (data.advisor): با کدام کار       */
/*    شروع کنم؟ (مشاور شروع)                                          */
/* ۲) «وضعیت برنامه‌ی امروز» — از useDaySuggestion                     */
/*    (GET /api/planner/suggestion): متعادل / سرریز / بدون ظرفیت +     */
/*    نشانِ کهنگی برنامه (§6.3.2) + کلید «چیدمان هوشمند».              */
/*                                                                    */
/* - فقط نمایش + یک کنترلِ نمایشی (چیدمان هوشمند). این کامپوننت هیچ    */
/*   mutation نمی‌نویسد؛ انتقال کارها فقط از دکمه‌ی «دیدن پیشنهاد» و با  */
/*   تأیید صریح کاربر در SuggestionModal انجام می‌شود (ADR-006 §3).     */
/* - advisor/suggestion نداشته باشد یا فقط-خواندنی خطا بدهد → بی‌صدا    */
/*   حذف می‌شود؛ نمای روز هرگز نمی‌شکند.                                */
/* - منطقِ «کار بعدی» به‌صورت buildAdvisorCardView خالص و تست‌پذیر       */
/*   استخراج شده — همان الگوی SettingsContext (محیط node بدون DOM).     */
/* ------------------------------------------------------------------ */

const priorityEmoji: Record<"HIGH" | "MEDIUM" | "LOW", string> = {
    HIGH: "🔴",
    MEDIUM: "🔸",
    LOW: "🔹",
}

export type AdvisorCardView =
    | { kind: "hidden" }
    | { kind: "allDone"; message: string }
    | {
          kind: "ready"
          greeting: string
          next: {
              taskId: number
              title: string
              emoji: string
              estimatedMinutes: number
              focusMinutes: number
              pauseAfterMinutes: number
              reason: string
          }
          focusNote: string
      }

/**
 * نمای خالصِ بخشِ «کار بعدی» — Pure function (بدون I/O، بدون JSX).
 * قوانین:
 * - advisor ندارد یا لیست کارها خالی است → hidden.
 * - nextTaskId تهی است ولی کارهایی وجود دارد → «همه انجام شده» با پیام خودِ مشاور.
 * - در غیر این صورت «آماده»: کارِ بعدی + بینشِ تمرکز/استراحت.
 */
export function buildAdvisorCardView(
    advisor: AdvisorResult | null | undefined,
    tasks: TaskItem[],
): AdvisorCardView {
    if (!advisor || tasks.length === 0) return { kind: "hidden" }

    if (advisor.nextTaskId === null) {
        return { kind: "allDone", message: advisor.message }
    }

    const item = advisor.items.find((i) => i.taskId === advisor.nextTaskId) ?? null
    const task = tasks.find((t) => t.id === advisor.nextTaskId) ?? null
    if (!item || !task) return { kind: "hidden" }

    return {
        kind: "ready",
        greeting: advisor.message,
        next: {
            taskId: task.id,
            title: task.title,
            emoji: task.priority ? priorityEmoji[task.priority] : "⚪",
            estimatedMinutes: item.estimatedMinutes,
            focusMinutes: item.focusMinutes,
            pauseAfterMinutes: item.pauseAfterMinutes,
            reason: item.reason,
        },
        // بینش کلیدی: تمرکز پیشنهادی در برابر استراحت بعدش — همان اعداد clamped موتور
        focusNote: `${fmtMinutes(item.focusMinutes)} تمرکز، بعدش ${fmtMinutes(
            item.pauseAfterMinutes,
        )} استراحت`,
    }
}

/* ---------- وضعیت برنامه‌ی امروز (منبع: GET /api/planner/suggestion) ---------- */

type StatusKind = "empty" | "allDone" | "noCapacity" | "overflow" | "balanced"

/**
 * وضعیتِ نمایشیِ روز — Pure function (بدون I/O).
 * ترتیب بررسی مهم است: روزِ خالی و همه‌انجام‌شده مقدم‌اند، و نبودِ ظرفیت
 * نباید به‌شکلِ «سرریز» (هشدارِ کاذب) نشان داده شود — کاربر فقط وقت آزاد را
 * تعیین نکرده است.
 */
function statusOf(tasks: TaskItem[], suggestion: SuggestionData): StatusKind {
    if (tasks.length === 0) return "empty"
    if (tasks.every((t) => t.status === "DONE")) return "allDone"
    if (suggestion.capacityMinutes <= 0) return "noCapacity"
    if (suggestion.unfitted.length > 0) return "overflow"
    return "balanced"
}

type Props = {
    /** فقط «امروزِ کانونیکال» کارت را می‌بیند؛ روزهای دیگر → null */
    enabled: boolean
    suggestion: SuggestionData | null
    loading: boolean
    error: string | null
    tasks: TaskItem[]
    /** مشاور شروع (GET /api/tasks → data.advisor) — بخش «کار بعدی» */
    advisor?: AdvisorResult | null
    isAdvisorOrderActive: boolean
    onToggleOrder: () => void
    onOpenModal: () => void
}

export default function AdvisorCard({
    enabled,
    suggestion,
    loading,
    error,
    tasks,
    advisor,
    isAdvisorOrderActive,
    onToggleOrder,
    onOpenModal,
}: Props) {
    if (!enabled) return null

    // بارگذاری اول: اسکلتِ نبض‌دار (بدون پرشِ چیدمان)
    if (loading && !suggestion) {
        return (
            <div className={styles.card} aria-busy="true" aria-label="در حال آماده‌سازی پیشنهاد روز">
                <span className={`${styles.skeleton} ${styles.skeletonWide}`} />
                <span className={`${styles.skeleton} ${styles.skeletonNarrow}`} />
            </div>
        )
    }

    // خطای فقط-خواندنی نباید نمای روز را خراب کند → کارت بی‌صدا حذف می‌شود
    if (!suggestion) return null

    const view = buildAdvisorCardView(advisor, tasks)
    const status = statusOf(tasks, suggestion)

    // برنامه‌ی کهنه (§6.3.2): نبودِ رکورد DailyPlan هم stale است، ولی برای پرهیز از
    // تکرار پیامِ «وقت آزاد امروزت را تعیین کن» نشان فقط وقتی می‌آید که یک پلنِ
    // واقعی عقب افتاده باشد.
    const stale = suggestion.state === "stale" && (suggestion.basis?.planVersion ?? 0) > 0
    // کلید چیدمان فقط جایی که معنا دارد: روزِ متعادل یا سرریز
    const showToggle = status === "balanced" || status === "overflow"
    // بدون کارِ برنامه‌ریزی‌شده، ترتیبِ هوشمند چیزی برای جابه‌جا کردن ندارد
    const canReorder = suggestion.planned.length > 0

    return (
        <div
            className={`${styles.card} ${status === "overflow" ? styles.cardWarn : ""}`}
            role="group"
            aria-label="مشاور برنامه‌ی روز"
        >
            {/* ۱) مشاور شروع — کارِ بعدی (برجسته) */}
            {view.kind === "ready" && (
                <div className={styles.nextBox}>
                    <span className={styles.nextLabel}>کار بعدی</span>
                    <div className={styles.nextRow}>
                        <span className={styles.emoji} aria-hidden="true">
                            {view.next.emoji}
                        </span>
                        <span className={styles.nextTitle}>{view.next.title}</span>
                        <span className={styles.est} dir="rtl">
                            ≈ {fmtMinutes(view.next.estimatedMinutes)}
                        </span>
                    </div>
                    <div className={styles.nextMeta}>
                        <span className={styles.reason}>{view.next.reason}</span>
                        {/* نسبت فوکوس/استراحت با نشانِ aria برای صفحه‌خوان‌ها */}
                        <span
                            className={styles.paceChip}
                            aria-label={`پیشنهاد زمان‌بندی: ${fmtMinutes(
                                view.next.focusMinutes,
                            )} تمرکز و سپس ${fmtMinutes(view.next.pauseAfterMinutes)} استراحت`}
                        >
                            🎯 {view.focusNote}
                        </span>
                    </div>
                </div>
            )}

            {/* ۲) وضعیت برنامه‌ی امروز */}
            {status === "empty" ? (
                <p className={styles.status} role="status">
                    <Sprout /> امروز هنوز کاری ثبت نشده — اولین کارت را بساز تا با هم برنامه‌ی متعادلی برای
                    امروز بچینیم.
                </p>
            ) : status === "allDone" ? (
                <p className={styles.status} role="status">
                    {view.kind === "allDone"
                        ? view.message
                        : <div>
                        <Coffee />
                        <span> کارهای امروز تمام شده — وقتشه استراحت کنی.</span>
                        </div>}
                </p>
            ) : (
                <>
                    <p
                        className={status === "overflow" ? styles.statusWarn : styles.status}
                        role="status"
                    >
                        {status === "overflow" ? (
                            <div style={{display:"flex" , alignItems:"center"}}>
                                <TriangleAlert /> 
                                <span style={{margin:"2px"}}>
                                {faDigits(suggestion.unfitted.length)} تسک ممکن است امروز انجام نشود.
                                </span>
                                </div>
                        ) : status === "noCapacity" ? (
                            <><HourglassCog /> برای پیشنهاد دقیق، «وقت آزاد» امروزت را تعیین کن.</>
                        ) : (
                            <>✅ برنامه‌ی امروز متعادل است — همه‌ی کارها در ظرفیت امروز جا می‌شوند.</>
                        )}
                    </p>

                    {stale && <span className={styles.staleChip}><TimerReset /> برنامه به بازمحاسبه نیاز دارد</span>}

                    {showToggle && (
                        <div className={styles.actions}>
                            {status === "overflow" && (
                                <button
                                    className={taskStyles.btnPrimary}
                                    onClick={onOpenModal}
                                    aria-label="نمایش پیشنهاد برنامه‌ی امروز"
                                >
                                    دیدن پیشنهاد
                                </button>
                            )}
                            <button
                                className={`${styles.toggle} ${
                                    isAdvisorOrderActive ? styles.toggleOn : ""
                                }`}
                                onClick={onToggleOrder}
                                aria-pressed={isAdvisorOrderActive}
                                disabled={!canReorder}
                                title={
                                    canReorder
                                        ? "نمایش کارها به ترتیب پیشنهاد امروز"
                                        : "برای این روز کاری برای اولویت‌دهی نیست"
                                }
                            >
                                <ShelvingUnit /> چیدمان هوشمند
                                <span className={styles.toggleState}>
                                    {isAdvisorOrderActive ? "روشن" : "خاموش"}
                                </span>
                            </button>
                        </div>
                    )}
                </>
            )}

            {/* خطای فقط-خواندنیِ پیشنهاد — پیام کوتاه و بی‌اثر روی کارها */}
            {error && (
                <p className={styles.footnote} role="note">
                    پیشنهاد امروز تازه نشد — ممکن است کمی قدیمی باشد.
                </p>
            )}
        </div>
    )
}
