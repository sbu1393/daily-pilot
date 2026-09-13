"use client"

import { faDigits, fmtMinutes } from "@/app/lib/time"
import { type AdvisorResult } from "@/app/lib/planner/advisor"
import { type TaskItem } from "./taskTypes"
import styles from "./advisor.module.css"

/* ------------------------------------------------------------------ */
/* AdvisorCard — Part 3/3: ویجت «مشاور شروع» روی نمای اصلی کارها.       */
/* - فقط نمایش: هیچ mutation و هیچ درخواست شبکه‌ای ندارد؛ داده‌ی آن      */
/*   همان پاسخ GET /api/tasks است (data.advisor — Part 2).              */
/* - advisor null/undefined یا لیست خالی → هیچی رندر نمی‌شود (آرام).     */
/* - همه‌ی کارها انجام شده → پیام تشویقی کوچک، بدون فشار.               */
/* - منطقِ نمایش به‌صورت buildAdvisorCardView استخراج شده تا در محیط     */
/*   node (بدون DOM/jsdom) تست‌پذیر باشد — همان الگوی SettingsContext.   */
/* ------------------------------------------------------------------ */

const priorityEmoji: Record<"HIGH" | "MEDIUM" | "LOW", string> = {
    HIGH: "🔴",
    MEDIUM: "🟠",
    LOW: "🟢",
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
 * نمای خالصِ کارت مشاور — Pure function (بدون I/O، بدون JSX).
 * قوانین:
 * - advisor ندارد یا لیست کارها خالی است → hidden (کارت اصلاً دیده نمی‌شود).
 * - nextTaskId تهی است ولی کارهایی وجود دارد → حالت «همه انجام شده» با پیام خودِ مشاور.
 * - در غیر این صورت «آماده»: تمرکز روی اولین کارِ بعدی + بینشِ فوکوس/استراحت.
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

type Props = {
    advisor: AdvisorResult | null | undefined
    tasks: TaskItem[]
}

export default function AdvisorCard({ advisor, tasks }: Props) {
    const view = buildAdvisorCardView(advisor, tasks)

    if (view.kind === "hidden") return null

    if (view.kind === "allDone") {
        return (
            <div className={`${styles.card} ${styles.cardDone}`} role="status">
                <span className={styles.greeting}>{view.message}</span>
            </div>
        )
    }

    const { next } = view

    return (
        <div className={styles.card} role="status" aria-label="مشاور شروع روز">
            <p className={styles.greeting}>{view.greeting}</p>

            {/* کار بعدی — برجسته */}
            <div className={styles.nextBox}>
                <span className={styles.nextLabel}>کار بعدی</span>
                <div className={styles.nextRow}>
                    <span className={styles.emoji} aria-hidden="true">
                        {next.emoji}
                    </span>
                    <span className={styles.nextTitle}>{next.title}</span>
                    <span className={styles.est} dir="rtl">
                        ≈ {fmtMinutes(next.estimatedMinutes)}
                    </span>
                </div>
                <div className={styles.nextMeta}>
                    <span className={styles.reason}>{next.reason}</span>
                    {/* نسبت فوکوس/استراحت با نشان aria برای صفحه‌خوان‌ها */}
                    <span
                        className={styles.paceChip}
                        aria-label={`پیشنهاد زمان‌بندی: ${fmtMinutes(next.focusMinutes)} تمرکز و سپس ${fmtMinutes(
                            next.pauseAfterMinutes,
                        )} استراحت`}
                    >
                        🎯 {view.focusNote}
                    </span>
                </div>
            </div>

            {advisor && advisor.overflowTaskIds.length > 0 && (
                <p className={styles.footnote} role="note">
                    {faDigits(advisor.overflowTaskIds.length)} کار دیگر جا نمی‌شود — پیشنهاد انتقال
                    آن‌ها در کارت «پیشنهاد برنامه» آمده است.
                </p>
            )}
        </div>
    )
}
