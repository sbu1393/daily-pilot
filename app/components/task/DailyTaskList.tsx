"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { useDaySummary, type DaySummary } from "../../hooks/UseDaySummary"
import { getCanonicalToday, shiftCanonicalKey } from "../../lib/canonicalDay"
import { faDigits } from "@/app/lib/time"
import {
    cacheDay,
    enqueueTask,
    isOffline,
    onOnline,
    readCachedDay,
    readQueue,
    syncQueue,
    type QueuedTask,
} from "@/app/lib/offline"
import { toast } from "react-toastify"
import { api } from "@/app/lib/api/client"
import { type TaskItem, type TaskPriority } from "./taskTypes"
import TaskCard from "./TaskCard"
import CreateTaskModal from "./CreateTaskModal"
import CompleteTaskModal from "./CompleteTaskModal"
import RolloverDialog from "./RolloverDialog"
import styles from "./task.module.css"
import ReanalyzeModal from "./ReanalyzeModal"


const priorityWeight: Record<TaskPriority, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 }

export default function DailyTaskList() {
    const { selectedDate, timezone } = useCalendar()
    const { summary, refresh: refreshSummary } = useDaySummary()

    const [tasks, setTasks] = useState<TaskItem[]>([])
    const [overdue, setOverdue] = useState<TaskItem[]>([])
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)

    const [createOpen, setCreateOpen] = useState(false)
    const [completeTask, setCompleteTask] = useState<TaskItem | null>(null)
    const [rolloverOpen, setRolloverOpen] = useState(false)
    const [deleteTask, setDeleteTask] = useState<TaskItem | null>(null)

    const [reanalyzeTask, setReanalyzeTask] = useState<TaskItem | null>(null)
    const [queuedTasks, setQueuedTasks] = useState<QueuedTask[]>([])
    const [offline, setOffline] = useState(false)

    const requestSeq = useRef(0) // محافظ race هنگام تعویض سریع روز

    /* نمایش تسک‌های صف‌شده‌ی آفلاین فقط برای همان روز */
    const visibleQueued = useMemo(
        () => queuedTasks.filter((q) => q.dayKey === selectedDate),
        [queuedTasks, selectedDate],
    )

    const refreshQueue = useCallback(() => {
        setQueuedTasks(
            readQueue().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        )
    }, [])

    const loadDay = useCallback(async () => {
        const seq = ++requestSeq.current
        setLoading(true)
        try {
            // ADR-04: { ok, data: { tasks, summary } } → data.tasks
            const data = await api<{ tasks: TaskItem[]; summary: DaySummary }>(
                `/api/tasks?dayKey=${selectedDate}`,
            )
            const dayTasks = data.tasks
            if (seq === requestSeq.current) {
                setTasks(dayTasks)
                setOffline(false)
            }
            /* کش محلی برای استفاده‌ی آفلاین بعدی — ADR-04: data = summary */
            try {
                const sum = await api<DaySummary>(`/api/planner/day?dayKey=${selectedDate}`)
                cacheDay(selectedDate, dayTasks, sum)
            } catch {
                cacheDay(selectedDate, dayTasks, null)
            }
        } catch (e) {
            if (seq === requestSeq.current) {
                /* آفلاین: به کش محلی برمی‌گردیم تا داشبورد کار کند */
                const cached = readCachedDay(selectedDate)
                if (cached) {
                    setTasks(cached.tasks)
                    setOffline(true)
                } else if (isOffline()) {
                    setTasks([])
                    setOffline(true)
                } else {
                    toast.error(e instanceof Error ? e.message : "خطا در دریافت تسک‌ها")
                }
            }
        } finally {
            if (seq === requestSeq.current) setLoading(false)
        }
    }, [selectedDate])

    // تسک‌های ناتمام روزهای قبل — اندپوینت مخصوص بازگرداندنِ تسک‌های عقب‌افتاده
    const loadOverdue = useCallback(async () => {
        try {
            // ADR-04: { ok, data: tasks } → خود data آرایه‌ی تسک‌هاست
            const data = await api<TaskItem[]>("/api/tasks/overdue")
            const limit = shiftCanonicalKey(getCanonicalToday(timezone), -6) // فقط ۷ روز اخیر
            setOverdue(data.filter((t) => t.dayKey >= limit))
        } catch {
            /* بی‌صدا */
        }
    }, [timezone])

    const refreshAll = useCallback(async () => {
        await Promise.all([loadDay(), loadOverdue()])
    }, [loadDay, loadOverdue])

    useEffect(() => {
        refreshAll()
        refreshQueue()
    }, [refreshAll, refreshQueue])

    /* وقتی آنلاین شدیم: صف را سینک کن و روز را دوباره بگیر */
    useEffect(() => {
        const off = onOnline(() => {
            void (async () => {
                const synced = await syncQueue()
                if (synced > 0) {
                    toast.success(`${faDigits(synced)} تسک آفلاین سینک شد ✅`)
                }
                refreshQueue()
                await refreshAll()
                refreshSummary(true)
            })()
        })
        return off
    }, [refreshAll, refreshQueue, refreshSummary])

    const afterMutation = useCallback(
        async (msg?: string) => {
            await Promise.all([refreshAll(), refreshSummary(true)])
            window.dispatchEvent(new Event("planner:mutated")) // نوار آمار فاز ۵ هم رفرش بشه
            if (msg) toast.success(msg)
        },
        [refreshAll, refreshSummary],
    )

    const ordered = useMemo(() => {
        const scoreOf = (t: TaskItem) => t.score ?? 0
        return [...tasks].sort((a, b) => {
            const aDone = a.status === "DONE" ? 1 : 0
            const bDone = b.status === "DONE" ? 1 : 0
            if (aDone !== bDone) return aDone - bDone
            if (aDone === 1) return (b.completedOn ?? "").localeCompare(a.completedOn ?? "")
            if (a.status === "IN_PROGRESS" && b.status !== "IN_PROGRESS") return -1
            if (b.status === "IN_PROGRESS" && a.status !== "IN_PROGRESS") return 1
            const d = scoreOf(b) - scoreOf(a)
            // null = تحلیلنشده → مثل LOW در صف میماند
            return d !== 0 ? d : priorityWeight[b.priority ?? "LOW"] - priorityWeight[a.priority ?? "LOW"]
        })
    }, [tasks])

    const doneCount = useMemo(() => tasks.filter((t) => t.status === "DONE").length, [tasks])
    const overCommitted = (summary?.overCommittedMinutes ?? 0) > 0

    const handleDelete = async () => {
        if (!deleteTask) return
        setBusy(true)
        try {
            await api(`/api/tasks/${deleteTask.id}`, { method: "DELETE" })
            setDeleteTask(null)
            await afterMutation("تسک حذف شد؛ زمانش به استخر روز برگشت 🕊")
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "خطا در حذف تسک")
        } finally {
            setBusy(false)
        }
    }

    const handleRollover = async (ids: number[]) => {
        setBusy(true)
        try {
            await api("/api/tasks/rollover", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskIds: ids }),
            })
            setRolloverOpen(false)
            await afterMutation("کارها به امروز منتقل و دوباره زمان‌بندی شدند ✅")
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "خطا در انتقال کارها")
        } finally {
            setBusy(false)
        }
    }


    return (
        <section className={styles.section}>
            <div className={styles.headerRow}>
                <h3>
                    برنامه روز {faDigits(selectedDate.replaceAll("-", "/"))}
                </h3>
                {tasks.length > 0 && (
                    <span className={styles.count}>
                        {faDigits(doneCount)} از {faDigits(tasks.length)} انجام شده
                    </span>
                )}
            </div>

            {overCommitted && (
                <div className={styles.warningBar}>
                    ⚠️ ظرفیت روز پر شده و زمان بعضی کارها کم شده. اگه تسک جدید اضافه کنی، از کارهای
                    کم‌اهمیت‌تر کم می‌شود — یا «زمان آزاد» روز را زیاد کن.
                </div>
            )}

            {overdue.length > 0 && (
                <div className={styles.banner}>
                    <span>
                        📥 {faDigits(overdue.length)} کار از روزهای قبل ناتمام مانده
                    </span>
                    <button className={styles.btnPrimary} onClick={() => setRolloverOpen(true)}>
                        انتقال به امروز
                    </button>
                </div>
            )}

            {loading && tasks.length === 0 ? (
                <p className={styles.empty}>در حال بارگذاری…</p>
            ) : ordered.length === 0 && visibleQueued.length === 0 ? (
                <div className={styles.empty}>
                    هنوز کاری برای این روز ثبت نشده.
                    <br />
                    اولین تسک را بساز تا هوش مصنوعی اولویت و زمان‌بندیش را مشخص کند.
                </div>
            ) : (
                <ul className={styles.list}>
                    {/* AnimatePresence تا کارت‌ها هنگام حذف/اتمام، با انیمیشن خارج شوند */}
                    <AnimatePresence initial={false} mode="popLayout">
                        {ordered.map((task) => (
                            <TaskCard
                                key={task.id}
                                task={task}
                                onComplete={setCompleteTask}
                                onDelete={setDeleteTask}
                                onReanalyze={setReanalyzeTask}
                            />
                        ))}

                        {/* تسک‌های ساخته‌شده در حالت آفلاین — هنوز سینک نشده‌اند */}
                        {visibleQueued.map((q) => (
                            <motion.li
                                key={q.id}
                                className={`${styles.card} ${styles.queuedCard}`}
                                initial={{ opacity: 0, y: 14 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, scale: .96 }}
                                layout
                            >
                                <div className={styles.topRow}>
                                    <span className={styles.text}>{q.title}</span>
                                </div>
                                <div className={styles.chips}>
                                    <span className="dp-queued-chip">⏳ در صف سینک — آفلاین</span>
                                    <span className={styles.chipTime}>
                                        🕐 {faDigits(new Date(q.createdAt).getHours())}:
                                        {faDigits(String(new Date(q.createdAt).getMinutes()).padStart(2, "0"))}
                                    </span>
                                </div>
                                <p className={styles.hint} style={{ margin: 0 }}>
                                    تحلیل هوش مصنوعی بعد از اتصال به اینترنت انجام می‌شود.
                                </p>
                            </motion.li>
                        ))}
                    </AnimatePresence>
                </ul>
            )}

            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} style={{ width: "fit-content" }}>
                <button className={styles.btnPrimary} onClick={() => setCreateOpen(true)}>
                    + تسک جدید
                </button>
            </motion.div>

            <CreateTaskModal
                open={createOpen}
                onClose={() => setCreateOpen(false)}
                onCreated={() => afterMutation()}
            />

            <CompleteTaskModal
                task={completeTask}
                onClose={() => setCompleteTask(null)}
                onCompleted={() => afterMutation()}
            />

            {rolloverOpen && overdue.length > 0 && (
                <RolloverDialog
                    tasks={overdue}
                    onClose={() => setRolloverOpen(false)}
                    onConfirm={handleRollover}
                    busy={busy}
                />
            )}

            {deleteTask && (
                <div className={styles.overlay} onClick={() => setDeleteTask(null)}>
                    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                        <div className={styles.modalHead}>
                            <h4>حذف تسک</h4>
                        </div>
                        <p className={styles.hint}>
                            «{deleteTask.title}» حذف شود؟ زمانِ تخصیص‌یافته‌اش به استخر روز برمی‌گردد.
                        </p>
                        <div className={styles.modalActions}>
                            <button
                                className={`${styles.btnPrimary} ${styles.btnDanger}`}
                                onClick={handleDelete}
                                disabled={busy}
                            >
                                حذف کن
                            </button>
                            <button className={styles.btnGhost} onClick={() => setDeleteTask(null)}>
                                انصراف
                            </button>
                        </div>
                    </div>
                </div>
            )}
            <ReanalyzeModal
                key={reanalyzeTask?.id ?? "none"} // باز شدن دوباره = مونت مجدد = state تمیز
                task={reanalyzeTask}
                onClose={() => setReanalyzeTask(null)}
                onDone={() => afterMutation()}
            />
        </section>
    )
}
