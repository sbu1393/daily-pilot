"use client"

import { useEffect, useState } from "react"
import { toast } from "react-toastify"
import { TaskItem, priorityMeta, categoryInfo } from "./taskTypes"
import { faDigits, fmtMinutes } from "@/app/lib/time"
import AnimatedModal from "../motion/AnimatedModal"
import styles from "./task.module.css"

type Props = {
    task: TaskItem | null
    onClose: () => void
    onDone: () => void // بعد از موفقیت: رفرش لیست + نوار آمار
}

function Chip({ label, color, bg }: { label: string; color: string; bg: string }) {
    return (
        <span className={styles.chip} style={{ color, background: bg }}>
            {label}
        </span>
    )
}

const fmtScore = (n: number | null) => (n == null ? "—" : faDigits(n))
const fmtEst = (n: number | null) => (n == null ? "—" : fmtMinutes(n))

export default function ReanalyzeModal({ task, onClose, onDone }: Props) {
    const [text, setText] = useState(task?.text ?? "")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // اسنپشاتِ وضعیت قبل — چون والد تا بسته شدن مودال، آبجکت قدیمی رو نگه می‌داره
    const [result, setResult] = useState<{ old: TaskItem; next: TaskItem; source: string } | null>(null)

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [onClose])

    if (!task) return null

    const trimmed = text.trim()
    const changed = trimmed !== task.text
    const canRun = !busy && (changed ? trimmed.length >= 3 : true)

    const run = async () => {
        if (!task || busy) return
        setBusy(true)
        setError(null)
        try {
            // اگه متن عوض نشده، بدنه خالی بفرست (سرور خودش از task.text استفاده می‌کنه)
            const body = changed ? { text: trimmed } : {}
            const res = await fetch(`/api/tasks/${task.id}/analyze`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            })
            const json = (await res.json().catch(() => ({}))) as {
                data?: unknown
                task?: unknown
                updated?: unknown
                message?: string
                aiSource?: string
            }
            if (!res.ok) throw new Error(json.message || "خطا در تحلیل مجدد")

            const next = (json.data ?? json.task ?? json.updated) as TaskItem | undefined
            if (!next) throw new Error("پاسخ سرور نامعتبر است")

            setResult({ old: { ...task }, next, source: json.aiSource ?? "" })
            onDone() // رفرش لیست و نوار آمار (بازتوزیع بودجه)
        } catch (e) {
            setError(e instanceof Error ? e.message : "خطا در تحلیل مجدد")
        } finally {
            setBusy(false)
        }
    }

    const old = result?.old
    const next = result?.next
    const unchanged =
        next && old &&
        next.priority === old.priority &&
        next.score === old.score &&
        next.estimatedTime === old.estimatedTime &&
        next.category === old.category

    return (
        <AnimatedModal open={task !== null} onClose={onClose}>

                {!result ? (
                    <>
                        <div className={styles.modalHead}>
                            <h4>تحلیل مجدد با هوش مصنوعی</h4>
                            <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">✕</button>
                        </div>

                        <p className={styles.hint}>
                            عنوان را در صورت نیاز ویرایش کن تا اولویت، امتیاز، زمان تخمینی و دسته‌بندی دوباره
                            محاسبه شود. این کار زمان تخصیص‌یافته به بقیه کارهای روز را هم بازتوزیع می‌کند.
                        </p>

                        <label className={styles.fieldLabel}>عنوان تسک</label>
                        <textarea
                            className={styles.textarea}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            autoFocus
                        />

                        <div className={styles.aiBox}>
                            <div className={styles.aiRow}>
                                <span className={styles.aiLabel}>تحلیل فعلی</span>
                                <span className={styles.aiValue}>
                                    <Chip {...priorityMeta[task.priority]} />
                                    <Chip {...categoryInfo(task.category)} />
                                    <span>امتیاز {fmtScore(task.score)}</span>
                                    <span>{fmtEst(task.estimatedTime)}</span>
                                </span>
                            </div>
                            {task.reason && <p className={styles.reason}>💡 {task.reason}</p>}
                        </div>

                        {error && <p className={styles.inlineError}>⚠️ {error}</p>}

                        <div className={styles.modalActions}>
                            <button className={styles.btnPrimary} onClick={run} disabled={!canRun}>
                                {busy ? <span className={styles.spin}>⏳</span> : "🔄"}{" "}
                                {busy ? "در حال تحلیل..." : "تحلیل مجدد"}
                            </button>
                            <button className={styles.btnGhost} onClick={onClose} disabled={busy}>
                                انصراف
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className={styles.modalHead}>
                            <h4>نتیجه تحلیل مجدد</h4>
                            <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">✕</button>
                        </div>

                        {unchanged ? (
                            <div className={styles.aiBox} style={{ textAlign: "center" }}>
                                <p className={styles.hint} style={{ margin: 0 }}>
                                    تحلیل تغییری نکرد — کارها سر جاشون موندن.
                                </p>
                                {result.source === "mock" && (
                                    <p className={styles.muted} style={{ margin: 0 }}>
                                        ⚠️ کلید API موجود نیست؛ نتیجه از تحلیل پیش‌فرض است.
                                    </p>
                                )}
                            </div>
                        ) : (
                            <div className={styles.aiBox}>
                                <div className={styles.aiRow}>
                                    <span className={styles.aiLabel}>اولویت</span>
                                    <span className={styles.aiValue}>
                                        <span className={styles.oldVal}>{priorityMeta[old!.priority].label}</span>
                                        <span className={styles.vs}>←</span>
                                        <Chip {...priorityMeta[next!.priority]} />
                                    </span>
                                </div>
                                <div className={styles.aiRow}>
                                    <span className={styles.aiLabel}>امتیاز</span>
                                    <span className={styles.aiValue}>
                                        <span className={styles.oldVal}>{fmtScore(old!.score)}</span>
                                        <span className={styles.vs}>←</span>
                                        <span className={styles.newVal}>{fmtScore(next!.score)}</span>
                                    </span>
                                </div>
                                <div className={styles.aiRow}>
                                    <span className={styles.aiLabel}>زمان تخمینی</span>
                                    <span className={styles.aiValue}>
                                        <span className={styles.oldVal}>{fmtEst(old!.estimatedTime)}</span>
                                        <span className={styles.vs}>←</span>
                                        <span className={styles.newVal}>{fmtEst(next!.estimatedTime)}</span>
                                    </span>
                                </div>
                                <div className={styles.aiRow}>
                                    <span className={styles.aiLabel}>دسته‌بندی</span>
                                    <span className={styles.aiValue}>
                                        <span className={styles.oldVal}>{categoryInfo(old!.category).label}</span>
                                        <span className={styles.vs}>←</span>
                                        <Chip {...categoryInfo(next!.category)} />
                                    </span>
                                </div>
                                <div className={styles.divider} />
                                <p className={styles.reason}>💡 {next!.reason ?? "—"}</p>
                            </div>
                        )}

                        {next && old && next.text !== old.text && (
                            <p className={styles.hint}>
                                عنوان به «{next.text}» تغییر کرد.
                            </p>
                        )}

                        {result.source === "1xai" && !unchanged && (
                            <p className={styles.muted}>منبع: تحلیل هوش مصنوعی</p>
                        )}

                        <div className={styles.modalActions}>
                            <button className={styles.btnPrimary} onClick={onClose}>
                                باشه
                            </button>
                        </div>
                    </>
                )}

        </AnimatedModal>
    )
}
