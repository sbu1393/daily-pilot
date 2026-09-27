"use client"

import { useMemo } from "react"

import AnimatedModal from "../motion/AnimatedModal"
import { faDigits, fmtMinutes } from "@/app/lib/time"
import { aiSourceNotice } from "@/app/lib/ai/aiSource"
import type { PlanProposal } from "@/app/lib/planner/planProposalFlow"
import { priorityMeta, priorityMissingMeta, type TaskItem } from "./taskTypes"
import { buildPlanProposalView, type PlanProposalViewRow } from "./planProposalView"
import taskStyles from "./task.module.css"
import styles from "./planProposal.module.css"

// Phase 4.3 — «برنامه پیشنهادی روز» (Preview + Confirmation)
// ----------------------------------------------------------
// این مودال یک *نمایندهٔ پیشنهاد* است، نه scheduler:
// - هیچ allocation/status/task را تغییر نمی‌دهد؛ فقط نمایش می‌دهد.
// - Accept فقط از طریق callback صریح (onAccept) به endpoint موجود Apply وصل می‌شود.
// - Close/Reject فقط محلی discard می‌کند (onClose) و هیچ mutation ای نمی‌زند.
// - `order` = rank قطعی موتور؛ `aiOrder` فقط advisory است و هرگز مثل time-slot/ساعت واقعی نشان داده نمی‌شود.
// - ظرفیت مستقیماً از proposal خوانده می‌شود (بدون بازمحاسبه).

type Props = {
    open: boolean
    proposal: PlanProposal
    /** لیست فعلی تسک‌های UI برای resolve کردن عنوان‌ها (بدون fetch per-task) */
    tasks: TaskItem[]
    isApplying?: boolean
    error?: string | null
    onAccept: () => void
    onClose: () => void
}

function PriorityTag({ priority }: { priority: PlanProposalViewRow["priority"] }) {
    const meta = priority != null ? priorityMeta[priority] : priorityMissingMeta
    return (
        <span className={styles.tag} style={{ color: meta.color, background: meta.bg }}>
            {meta.label}
        </span>
    )
}

const fmtScore = (n: number | null) => (n == null ? "—" : faDigits(n))

export default function PlanProposalModal({
    open,
    proposal,
    tasks,
    isApplying = false,
    error = null,
    onAccept,
    onClose,
}: Props) {
    const view = useMemo(() => buildPlanProposalView(proposal, tasks), [proposal, tasks])

    // هنگام Apply، بستن (Escape/overlay/✕) قفل می‌شود تا وضعیت نیمه‌کاره نشود
    const guardedClose = () => {
        if (isApplying) return
        onClose()
    }

    const utilization =
        view.summary.availableMinutes > 0
            ? Math.min(100, Math.max(0, Math.round((view.summary.plannedMinutes / view.summary.availableMinutes) * 100)))
            : 0

    const sourceNotice = aiSourceNotice(view.source)

    return (
        <AnimatedModal open={open} onClose={guardedClose}>
            <div role="dialog" aria-modal="true" aria-label="پیشنهاد برنامهٔ روز">
                <div className={taskStyles.modalHead}>
                    <h4>🧠 برنامه پیشنهادی روز</h4>
                    <button
                        className={taskStyles.closeBtn}
                        onClick={guardedClose}
                        disabled={isApplying}
                        aria-label="بستن پیشنهاد"
                    >
                        ✕
                    </button>
                </div>

                <p className={styles.notice}>
                    این فقط یک <b>پیشنهاد</b> است؛ تا وقتی تأیید نکنی هیچ تغییری در برنامهٔ روزت اعمال
                    نمی‌شود.
                </p>
                {view.summaryText && <p className={styles.hint}>🗒️ {view.summaryText}</p>}

                <div className={styles.content}>
                    {/* خلاصهٔ ظرفیت — مقادیر مستقیماً از proposal */}
                    <div className={styles.summaryBox}>
                        <div className={styles.summaryGrid}>
                            <div className={styles.summaryCell}>
                                <span className={styles.summaryLabel}>ظرفیت امروز</span>
                                <span className={styles.summaryValue}>{fmtMinutes(view.summary.availableMinutes)}</span>
                            </div>
                            <div className={styles.summaryCell}>
                                <span className={styles.summaryLabel}>برنامه‌ریزی‌شده</span>
                                <span className={styles.summaryValue}>{fmtMinutes(view.summary.plannedMinutes)}</span>
                            </div>
                            <div className={styles.summaryCell}>
                                <span className={styles.summaryLabel}>باقی‌مانده</span>
                                <span className={styles.summaryValue}>{fmtMinutes(view.summary.remainingMinutes)}</span>
                            </div>
                            <div className={styles.summaryCell}>
                                <span className={styles.summaryLabel}>کارهای جاافتاده</span>
                                <span className={styles.summaryValue}>{faDigits(view.summary.plannedCount)}</span>
                            </div>
                            <div className={styles.summaryCell}>
                                <span className={styles.summaryLabel}>کارهای جا‌نشده</span>
                                <span className={styles.summaryValue}>{faDigits(view.summary.unfittedCount)}</span>
                            </div>
                        </div>
                        <div
                            className={styles.summaryGrid}
                            role="progressbar"
                            aria-valuenow={utilization}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuetext={`${faDigits(utilization)} درصد از ظرفیت امروز`}
                            aria-label="مصرف ظرفیت امروز"
                            style={{ gridTemplateColumns: "1fr" }}
                        >
                            <div style={{ height: 6, background: "#eaecf0", borderRadius: 999, overflow: "hidden" }}>
                                <div
                                    style={{
                                        width: `${utilization}%`,
                                        height: "100%",
                                        background: "#175cd3",
                                        transition: "width .2s ease",
                                    }}
                                />
                            </div>
                        </div>
                    </div>

                    {/* برنامه‌ریزی‌شده — به ترتیب rank قطعی موتور */}
                    <h5 className={styles.sectionTitle}>برنامه‌ی امروز</h5>
                    {view.planned.length === 0 ? (
                        <p className={styles.emptyNote}>هیچ کاری در ظرفیت امروز جا نمی‌شود.</p>
                    ) : (
                        <ul className={styles.list}>
                            {view.planned.map((item) => (
                                <li key={item.taskId} className={styles.row}>
                                    <span className={styles.rowIndex}>{faDigits(item.order ?? 0)}</span>
                                    <div className={styles.rowMain}>
                                        <span className={styles.rowTitle}>
                                            {item.title}
                                            {!item.titleResolved && (
                                                <span className={`${styles.tag} ${styles.fallback}`} style={{ marginInlineStart: 6 }}>
                                                    حذف‌شده
                                                </span>
                                            )}
                                        </span>
                                        <span className={styles.rowMeta}>
                                            <span>{fmtMinutes(item.estimatedMinutes)}</span>
                                            <PriorityTag priority={item.priority} />
                                            <span className={styles.tag}>امتیاز {fmtScore(item.score)}</span>
                                            {item.partial && (
                                                <span className={`${styles.tag} ${styles.partial}`}>کاهش‌یافته</span>
                                            )}
                                            {item.aiOrder != null && (
                                                <span className={styles.tag}>
                                                    ترتیب پیشنهادی AI: {faDigits(item.aiOrder)}
                                                </span>
                                            )}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* جا‌نشده‌ها — بدون هیچ حذف/تعویق/تغییر وضعیت خودکار */}
                    <h5 className={styles.sectionTitle}>کارهایی که در ظرفیت امروز جا نمی‌شوند</h5>
                    {view.unfitted.length === 0 ? (
                        <p className={styles.emptyNote}>همهٔ کارها در ظرفیت امروز جا شدند. 🎉</p>
                    ) : (
                        <ul className={styles.list}>
                            {view.unfitted.map((item) => (
                                <li key={item.taskId} className={styles.row}>
                                    <span className={styles.rowIndex}>•</span>
                                    <div className={styles.rowMain}>
                                        <span className={styles.rowTitle}>
                                            {item.title}
                                            {!item.titleResolved && (
                                                <span className={`${styles.tag} ${styles.fallback}`} style={{ marginInlineStart: 6 }}>
                                                    حذف‌شده
                                                </span>
                                            )}
                                        </span>
                                        <span className={styles.rowMeta}>
                                            <span>{fmtMinutes(item.estimatedMinutes)}</span>
                                            <PriorityTag priority={item.priority} />
                                            <span className={styles.tag}>امتیاز {fmtScore(item.score)}</span>
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}

                    <p className={styles.hint}>
                        کارهای جا‌نشده دست‌نخورده می‌مانند؛ هیچ کاری خودکار حذف، موکول یا جابه‌جا نمی‌شود.
                    </p>
                    {sourceNotice && <p className={styles.hint}>{sourceNotice}</p>}
                </div>

                {error && (
                    <p className={taskStyles.inlineError} role="alert">
                        ⚠️ {error}
                    </p>
                )}

                <div className={taskStyles.modalActions}>
                    <button
                        className={taskStyles.btnPrimary}
                        onClick={onAccept}
                        disabled={isApplying}
                        aria-disabled={isApplying}
                    >
                        {isApplying ? "⏳ در حال اعمال…" : "✅ تأیید و اعمال برنامه"}
                    </button>
                    <button className={taskStyles.btnGhost} onClick={guardedClose} disabled={isApplying}>
                        فعلاً نه
                    </button>
                </div>
            </div>
        </AnimatedModal>
    )
}
