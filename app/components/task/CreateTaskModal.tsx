"use client"

import { useEffect, useState } from "react"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { enqueueTask, isOffline } from "@/app/lib/offline"
import { canonicalKeyToLocalMidnight } from "@/app/lib/canonicalDay"
import { api } from "@/app/lib/api/client"
import { toast } from "react-toastify"
import AnimatedModal from "../motion/AnimatedModal"
import styles from "./task.module.css"
import { formatCanonicalToJalali } from "../../lib/time"
import { NotebookPen, Unplug } from "lucide-react"
import {
    buildCreateTaskBody,
    CATEGORY_REQUIRED_MESSAGE,
    TASK_CATEGORIES,
    validateCreateForm,
    type TaskCategoryKey,
} from "./createTaskForm"


type Props = {
    open: boolean
    onClose: () => void
    onCreated: () => void
}

export default function CreateTaskModal({ open, onClose, onCreated }: Props) {
    const { selectedDate, timezone } = useCalendar()
    const [text, setText] = useState("")
    // دسته‌بندی اجباری است و **هیچ پیش‌فرضی ندارد** — تا وقتی کاربر خودش انتخاب
    // نکرده، `null` است و submit مسدود می‌شود.
    const [category, setCategory] = useState<TaskCategoryKey | null>(null)
    const [categoryError, setCategoryError] = useState(false)
    const [loading, setLoading] = useState(false)
    const [offline, setOffline] = useState(false)

    // بستن/باز شدن دوباره: پیام خطا نباید از قبل باقی بماند
    useEffect(() => {
        if (open) setCategoryError(false)
    }, [open])

    useEffect(() => {
        if (!open) return
        const h = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", h)
        return () => window.removeEventListener("keydown", h)
    }, [open, onClose])

    /* تشخیص وضعیت شبکه هنگام باز شدن مودال */
    useEffect(() => {
        if (!open) return
        setOffline(isOffline())
        const sync = () => setOffline(isOffline())
        window.addEventListener("online", sync)
        window.addEventListener("offline", sync)
        return () => {
            window.removeEventListener("online", sync)
            window.removeEventListener("offline", sync)
        }
    }, [open])

    /* ذخیره در صف آفلاین — تحلیل AI بعد از سینک انجام می‌شود */
    // C1: قرارداد ساخت = title + scheduledDate (ISO نیمه‌شب محلی روز انتخابی)؛ dayKey سمت سرور ساخته می‌شود (§6.2.2.1)
    const saveOffline = (value: string, cat: TaskCategoryKey) => {
        enqueueTask({
            title: value,
            category: cat,
            dayKey: selectedDate,
            scheduledDate: canonicalKeyToLocalMidnight(selectedDate, timezone).toISOString(),
        })
        toast.info(`${<Unplug />} آفلاین هستی — کار ذخیره شد و بعد از اتصال سینک می‌شود`)
        setText("")
        setCategory(null)
        onClose()
        onCreated()
    }

    const submit = async () => {
        // یک دروازهٔ واحد: اگر عنوان یا دسته معتبر نباشد، هیچ درخواستی ارسال
        // نمی‌شود. سرور هم جداگانه (و مستقل) همین قاعده را در schema اعمال می‌کند.
        const validation = validateCreateForm(text, category)
        if (!validation.ok) {
            if (validation.message === CATEGORY_REQUIRED_MESSAGE) setCategoryError(true)
            toast.error(validation.message)
            return
        }
        const cat = validation.category
        const value = text.trim()

        if (isOffline()) {
            saveOffline(value, cat)
            return
        }

        setLoading(true)
        try {
            await api("/api/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(
                    buildCreateTaskBody(
                        value,
                        canonicalKeyToLocalMidnight(selectedDate, timezone).toISOString(),
                        cat,
                    ),
                ),
            })

            setText("")
            setCategory(null)
            setCategoryError(false)
            onClose()
            onCreated()
            toast.success("کار ساخته شد و زمان‌بندی شد ✅")
        } catch (e) {
            /* خطای شبکه حین ارسال → ذخیره در صف آفلاین */
            if (e instanceof TypeError) {
                saveOffline(value, cat)
            } else {
                toast.error(e instanceof Error ? e.message : "خطا در ایجاد کار")
            }
        } finally {
            setLoading(false)
        }
    }

    return (
        <AnimatedModal open={open} onClose={onClose}>
            <div className={styles.modalHead}>
                <NotebookPen />
                <h4>کار جدید</h4>
                <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">✕</button>
            </div>
            {offline && (
                <div className="dp-queued-chip" style={{ justifyContent: "center" }}>
                    <Unplug /> آفلاین — کار محلی ذخیره و بعداً سینک می‌شود
                </div>
            )}
            <p className={styles.hint}>
                برای روز <b>{formatCanonicalToJalali(selectedDate)}</b>
                — دسته‌بندی را خودت انتخاب کن و کار بدون تحلیل ساخته میشه
                بعداً با «تحلیل مجدد» می‌تونی اولویت، امتیاز، دلیل و زمان تخمینی را با هوش مصنوعی تعیین کنی.
            </p>

            <input
                autoFocus
                className={styles.input}
                placeholder="مثلاً: آماده کردن گزارش مشتری"
                value={text}
                maxLength={200}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !loading) submit()
                }}
            />
            <fieldset className={styles.categoryFieldset}>
                <legend className={styles.categoryLegend}>دسته‌بندی *</legend>
                <div className={styles.categoryGrid} role="radiogroup" aria-label="دسته‌بندی">
                    {TASK_CATEGORIES.map((cat) => {
                        const selected = category === cat.key
                        return (
                            <button
                                type="button"
                                key={cat.key}
                                role="radio"
                                aria-checked={selected}
                                className={`${styles.categoryChip} ${selected ? styles.categoryChipSelected : ""}`}
                                onClick={() => {
                                    setCategory(cat.key)
                                    setCategoryError(false)
                                }}
                            >
                                <span aria-hidden="true">{cat.icon}</span>
                                <span>{cat.label}</span>
                            </button>
                        )
                    })}
                </div>
                {categoryError && (
                    <p className={styles.categoryError} role="alert">
                        {CATEGORY_REQUIRED_MESSAGE}
                    </p>
                )}
            </fieldset>
            <div className={styles.modalActions}>
                <button className={styles.btnPrimary} onClick={submit} disabled={loading}>
                    {loading ? "⏳ در حال ساخت…" : "ایجاد کار"}
                </button>
                <button className={styles.btnGhost} onClick={onClose} disabled={loading}>
                    انصراف
                </button>
            </div>
        </AnimatedModal>
    )
}
