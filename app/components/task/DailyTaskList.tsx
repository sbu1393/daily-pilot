"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { useDaySummary, type DaySummary } from "../../hooks/useDaySummary"
import { getCanonicalToday, shiftCanonicalKey } from "../../lib/canonicalDay"
import { faDigits } from "@/app/lib/time"
import {
    cacheDay,
    // rebase: enqueueTask حذف شد (نسخه‌ی remote) چون در این کامپوننت استفاده نمی‌شود؛
    // ensureOfflineScope از H2 باقی می‌ماند.
    ensureOfflineScope,
    isOffline,
    onOnline,
    readCachedDay,
    readQueue,
    syncQueue,
    type QueuedTask,
} from "@/app/lib/offline"
import { toast } from "react-toastify"
import { api, ApiClientError } from "@/app/lib/api/client"
import { type TaskItem, type TaskPriority } from "./taskTypes"
import TaskCard from "./TaskCard"
import CreateTaskModal from "./CreateTaskModal"
import CompleteTaskModal from "./CompleteTaskModal"
import RolloverDialog from "./RolloverDialog"
import styles from "./task.module.css"
import ReanalyzeModal from "./ReanalyzeModal"
import SuggestionCard from "./SuggestionCard"
import SuggestionModal, { type SuggestionData } from "./SuggestionModal"
import AdvisorCard from "./AdvisorCard"
import { type AdvisorResult } from "@/app/lib/planner/advisor"
import { formatCanonicalToJalali } from "../../lib/time"
import { LayersPlus, Megaphone, RotateCwFadingClock } from "lucide-react"

const priorityWeight: Record<TaskPriority, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 }

export default function DailyTaskList() {
    const { selectedDate, timezone } = useCalendar()
    const { summary, refresh: refreshSummary } = useDaySummary()

    const [tasks, setTasks] = useState<TaskItem[]>([])
    // Part 3/3 — مشاور شروع: از همان GET /api/tasks می‌آید (data.advisor) — فقط نمایش
    const [advisor, setAdvisor] = useState<AdvisorResult | null>(null)
    const [overdue, setOverdue] = useState<TaskItem[]>([])
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)

    const [createOpen, setCreateOpen] = useState(false)
    const [completeTask, setCompleteTask] = useState<TaskItem | null>(null)
    const [rolloverOpen, setRolloverOpen] = useState(false)
    const [deleteTask, setDeleteTask] = useState<TaskItem | null>(null)
    const [reanalyzeTask, setReanalyzeTask] = useState<TaskItem | null>(null)
    
    // استیت‌های مربوط به هوش مصنوعی
    const [suggestionOpen, setSuggestionOpen] = useState(false)
    const [suggestionData, setSuggestionData] = useState<SuggestionData | null>(null)

    const [queuedTasks, setQueuedTasks] = useState<QueuedTask[]>([])
    
    const requestSeq = useRef(0)

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
        // H2: scope کاربر (user-scoped کش/صف) موازی با بارگذاری روز مشخص می‌شود و
        // قبل از هر تماس با کش محلی await می‌شود.
        const scopeReady = ensureOfflineScope()
        try {
            const data = await api<{ tasks: TaskItem[]; summary: DaySummary; advisor?: AdvisorResult | null }>(
                `/api/tasks?dayKey=${selectedDate}`,
            )
            const dayTasks = data.tasks
            if (seq === requestSeq.current) {
                setTasks(dayTasks)
                setAdvisor(data.advisor ?? null)
            }
            try {
                const sum = await api<DaySummary>(`/api/planner/day?dayKey=${selectedDate}`)
                await scopeReady
                cacheDay(selectedDate, dayTasks, sum)
            } catch {
                await scopeReady
                cacheDay(selectedDate, dayTasks, null)
            }
        } catch (e) {
            if (seq === requestSeq.current) {
                /* آفلاین: به کش محلی برمی‌گردیم تا داشبورد کار کند */
                await scopeReady // H2: کش فقط با scope مشخص خوانده می‌شود
                const cached = readCachedDay(selectedDate)
                if (cached) {
                    setTasks(cached.tasks)
                    // مشاور فقط از داده‌ی تازه‌ی سرور معنا دارد؛ در حالت آفلاین/کش مخفی می‌شود
                    setAdvisor(null)
                } else if (isOffline()) {
                    setTasks([])
                } else {
                    toast.error(e instanceof Error ? e.message : "خطا در دریافت کارها")
                }
            }
        } finally {
            if (seq === requestSeq.current) setLoading(false)
        }
    }, [selectedDate])

    const loadOverdue = useCallback(async () => {
        try {
            const data = await api<TaskItem[]>("/api/tasks/overdue")
            const limit = shiftCanonicalKey(getCanonicalToday(timezone), -6)
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
        // H2: صف فقط بعد از مشخص شدن scope کاربر خوانده می‌شود
        void ensureOfflineScope().then(refreshQueue)
    }, [refreshAll, refreshQueue])

    useEffect(() => {
        const off = onOnline(() => {
            void (async () => {
                await ensureOfflineScope() // H2: scope پیش از سینک صف
                const synced = await syncQueue()
                if (synced > 0) {
                    toast.success(`${faDigits(synced)} کار آفلاین سینک شد ✅`)
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
            window.dispatchEvent(new Event("planner:mutated"))
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
            await afterMutation("کار حذف شد؛ زمانش به استخر روز برگشت 🕊")
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "خطا در حذف کار")
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

    // ADR-006 (S4) + A1 Phase 4: انتقال «به فردا» از پیشنهاد روز — همان اندپوینت موجود.
    // planVersion فقط وقتی فرستاده می‌شود که blueprint نسخه داشته باشد (گارد اپتیمیستیک).
    // rebase: مودال الآن توسط همین کامپوننت رندر می‌شود و snapshot داده را نگه می‌دارد؛ پس در
    // PLAN_STALE مودال بسته می‌شود (داده‌ی کهنه دیگر قابل تأیید نیست)، کارت با
    // planner:mutated پیشنهاد تازه می‌گیرد و کاربر با دیدن نسخه‌ی جدید دوباره تأیید می‌کند.
    // بقیه‌ی خطاها دوباره پرتاب می‌شوند تا مودال خودش آن‌ها را نمایش دهد.
    const handleSuggestionRollover = async (ids: number[], planVersion?: number) => {
        setBusy(true)
        try {
            await api("/api/tasks/rollover", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskIds: ids, planVersion }),
            })
            await afterMutation("کارهای مشخص‌شده به فردا منتقل شدند ✅")
        } catch (e) {
            if (e instanceof ApiClientError && e.code === "PLAN_STALE") {
                window.dispatchEvent(new Event("planner:mutated")) // پیشنهاد تازه
                setSuggestionOpen(false)
                toast.info(
                    "برنامه‌ی امروز با تغییرات اخیر همخوان نیست — هیچ تغییری اعمال نشد؛ پیشنهاد تازه را ببین و دوباره تأیید کن",
                )
                return // خطا در همان‌جا مدیریت شد (بدون نوشتن در دیتابیس)
            }
            throw e instanceof Error ? e : new Error("خطا در انتقال کارها")
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className={styles.section}>
            <div className={styles.headerRow}>
                <h3>برنامه‌ی روز {formatCanonicalToJalali(selectedDate)}</h3>
                {tasks.length > 0 && (
                    <span className={styles.count}>
                        {faDigits(doneCount)} از {faDigits(tasks.length)} انجام شده
                    </span>
                )}
            </div>

            {overCommitted && (
                <div className={styles.warningBar}>
                    ⚠️ ظرفیت روز پر شده و زمان بعضی کارها کم شده. اگه کار جدید اضافه کنی، از کارهای کم‌اهمیت‌ تر کم میشه — یا «زمان آزاد» روز رو زیاد کن.
                </div>
            )}

            {/* مشاور شروع (Part 3/3) — فقط نمایش، بدون هیچ جهشی؛ فقط برای روز امروز */}
            {selectedDate === getCanonicalToday(timezone) && (
                <AdvisorCard advisor={advisor} tasks={tasks} />
            )}

            {/* بخش پیشنهاد هوش مصنوعی */}
            {selectedDate === getCanonicalToday(timezone) && (
                <SuggestionCard
                    dayKey={selectedDate}
                    tasks={tasks}
                    onOpenModal={(data) => {
                        setSuggestionData(data)
                        setSuggestionOpen(true)
                    }}
                />
            )}

            {overdue.length > 0 && (
                <div className={styles.banner}>
                    <span>
                        <Megaphone /> {faDigits(overdue.length)} کار از روزهای قبل ناتمام مانده
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
                    هنوز کاری برای این روز ثبت نشده.<br />
                    اولین کار را بساز تا هوش مصنوعی اولویت و زمانبندی رو مشخص کنه.
                </div>
            ) : (
                <ul className={styles.list}>
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
                                        <RotateCwFadingClock /> {faDigits(new Date(q.createdAt).getHours())}:
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
                    <LayersPlus /> کار جدید
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
            
            {/* مودال پیشنهاد هوش مصنوعی */}
            {suggestionData && (
                <SuggestionModal
                    open={suggestionOpen}
                    onClose={() => setSuggestionOpen(false)}
                    suggestion={suggestionData}
                    tasks={tasks}
                    onRollover={handleSuggestionRollover}
                />
            )}

            {deleteTask && (
                <div className={styles.overlay} onClick={() => setDeleteTask(null)}>
                    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                        <div className={styles.modalHead}>
                            <h4>حذف کار</h4>
                        </div>
                        <p className={styles.hint}>
                            «{deleteTask.title}» حذف شود؟ زمانِ تخصیص‌ یافته‌اش به استخر روز برمی گرده.
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
                key={reanalyzeTask?.id ?? "none"}
                task={reanalyzeTask}
                onClose={() => setReanalyzeTask(null)}
                onDone={() => afterMutation()}
            />
        </section>
    )
}
