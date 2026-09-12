"use client"

import { useCallback, useEffect, useState } from "react"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { getCanonicalToday } from "../../lib/canonicalDay"
import { api } from "@/app/lib/api/client"
import { faDigits, fmtMinutes } from "@/app/lib/time"
import { toast } from "react-toastify"
import styles from "./history.module.css"
import {formatCanonicalToJalali} from "../../lib/time"


type TaskItem = {
    id: number
    title: string
    category: string | null
    status: "TODO" | "IN_PROGRESS" | "DONE"
    allocatedMinutes: number | null
    spentMinutes: number | null
}

const savedOf = (t: TaskItem) => Math.max(0, (t.allocatedMinutes ?? 0) - (t.spentMinutes ?? 0))
const overspentOf = (t: TaskItem) => Math.max(0, (t.spentMinutes ?? 0) - (t.allocatedMinutes ?? 0))

export default function DayHistoryPanel() {
    const { selectedDate, timezone } = useCalendar()
    const [tasks, setTasks] = useState<TaskItem[]>([])
    const [loading, setLoading] = useState(false)
    const [rolling, setRolling] = useState(false)

    const isPast = selectedDate < getCanonicalToday(timezone)

    const load = useCallback(async () => {
        // --- GUARD CLAUSE: اگر تاریخ هنوز آماده نیست، درخواست نزن ---
        if (!selectedDate || selectedDate.trim() === "") {
            return
        }

        setLoading(true)
        try {
            const data = await api<{ tasks: TaskItem[] }>(`/api/tasks?dayKey=${selectedDate}`)
            setTasks(data.tasks ?? [])
        } catch (e) {
            console.error(e)
            toast.error(e instanceof Error ? e.message : "خطا در دریافت تاریخچه")
        } finally {
            setLoading(false)
        }
    }, [selectedDate])

    useEffect(() => {
        if (isPast) load()
        else setTasks([])
    }, [isPast, load])

    useEffect(() => {
        const onMutated = () => { if (isPast) load() }
        window.addEventListener("planner:mutated", onMutated)
        return () => window.removeEventListener("planner:mutated", onMutated)
    }, [isPast, load])

    if (!isPast) return null

    const done = tasks.filter((t) => t.status === "DONE")
    const leftovers = tasks.filter((t) => t.status !== "DONE")
    const totalSpent = done.reduce((s, t) => s + (t.spentMinutes ?? 0), 0)
    const totalSaved = done.reduce((s, t) => s + savedOf(t), 0)
    const totalOverspent = done.reduce((s, t) => s + overspentOf(t), 0)

    const handleRolloverAll = async () => {
        if (!leftovers.length || rolling) return
        setRolling(true)
        try {
            await api("/api/tasks/rollover", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskIds: leftovers.map((t) => t.id) }),
            })
            toast.success(`${faDigits(leftovers.length)} کار به امروز منتقل شد`)
            window.dispatchEvent(new Event("planner:mutated"))
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "خطا در انتقال کارها")
        } finally {
            setRolling(false)
        }
    }

    return (
        <section className={styles.section}>
            <div className={styles.head}>
                <h3>تاریخچه‌ی این روز</h3>
                <span className={styles.date}>
                    {selectedDate ? formatCanonicalToJalali(selectedDate) : ""}
                </span>
            </div>


            <div className={styles.statsRow}>
                <div className={styles.stat}>
                    <span className={styles.statLabel}>کار انجام‌شده</span>
                    <span className={styles.statValue}>{faDigits(done.length)} کار</span>
                </div>
                <div className={styles.stat}>
                    <span className={styles.statLabel}>زمان واقعی صرف‌ شده</span>
                    <span className={styles.statValue}>{fmtMinutes(totalSpent)}</span>
                </div>
                {totalSaved > 0 && (
                    <div className={styles.stat}>
                        <span className={styles.statLabel}>زمان سیو شده 🎉</span>
                        <span className={`${styles.statValue} ${styles.good}`}>+{fmtMinutes(totalSaved)}</span>
                    </div>
                )}
                {totalOverspent > 0 && (
                    <div className={styles.stat}>
                        <span className={styles.statLabel}>بیش‌ مصرفی</span>
                        <span className={`${styles.statValue} ${styles.bad}`}>−{fmtMinutes(totalOverspent)}</span>
                    </div>
                )}
            </div>

            {loading ? (
                <p className={styles.loading}>در حال بارگذاری...</p>
            ) : done.length === 0 && leftovers.length === 0 ? (
                <p className={styles.empty}>کاری در این روز ثبت نشده </p>
            ) : (
                <>
                    {done.length > 0 && (
                        <div className={styles.block}>
                            <h4 className={styles.blockTitle}>انجام‌شده‌ها</h4>
                            <ul className={styles.list}>
                                {done.map((t) => {
                                    const saved = savedOf(t)
                                    const over = overspentOf(t)
                                    const base = t.allocatedMinutes ?? 0
                                    return (
                                        <li key={t.id} className={styles.item}>
                                            <div className={styles.itemMain}>
                                                <span className={styles.itemText}>{t.title}</span>
                                                <span className={styles.itemCat}>{t.category ?? "بدون دسته"}</span>
                                            </div>
                                            <div className={styles.itemMeta}>
                                                <span className={styles.metaChip}>تخصیص: {fmtMinutes(base)}</span>
                                                <span className={styles.metaChip}>واقعی: {fmtMinutes(t.spentMinutes ?? 0)}</span>
                                                {saved > 0 && (
                                                    <span className={`${styles.metaChip} ${styles.savedChip}`}>+{fmtMinutes(saved)} سیو</span>
                                                )}
                                                {over > 0 && (
                                                    <span className={`${styles.metaChip} ${styles.overChip}`}>−{fmtMinutes(over)} بیش‌ مصرفی</span>
                                                )}
                                            </div>
                                        </li>
                                    )
                                })}
                            </ul>
                        </div>
                    )}

                    {leftovers.length > 0 && (
                        <div className={styles.block}>
                            <div className={styles.leftoverNote}>
                                {faDigits(leftovers.length)} کار از این روز باقی مانده و هنوز انجام نشده.
                            </div>
                            <button
                                className={styles.rolloverBtn}
                                onClick={handleRolloverAll}
                                disabled={rolling}
                            >
                                {rolling ? "در حال انتقال..." : "انتقال همه به امروز"}
                            </button>
                        </div>
                    )}
                </>
            )}
        </section>
    )
}
