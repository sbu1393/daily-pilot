"use client"

import { useEffect, useState } from "react"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { enqueueTask, isOffline } from "@/app/lib/offline"
import { canonicalKeyToLocalMidnight } from "@/app/lib/canonicalDay"
import { reminderInstantFromLocal } from "@/app/lib/reminder"
import TaskReminderField, { defaultReminderDraft, type ReminderDraft } from "./TaskReminderField"
import { api } from "@/app/lib/api/client"
import { toast } from "react-toastify"
import AnimatedModal from "../motion/AnimatedModal"
import styles from "./task.module.css"
import { formatCanonicalToJalali } from "../../lib/time"
import { NotebookPen, Unplug } from "lucide-react"


type Props = {
    open: boolean
    onClose: () => void
    onCreated: () => void
}

export default function CreateTaskModal({ open, onClose, onCreated }: Props) {
    const { selectedDate, timezone } = useCalendar()
    const [text, setText] = useState("")
    const [loading, setLoading] = useState(false)
    const [offline, setOffline] = useState(false)
    const [reminder, setReminder] = useState<ReminderDraft>(() => defaultReminderDraft(selectedDate))

    // با هر باز شدن مودال، فیلد یادآوری به حالت پیش‌فرض روزِ انتخاب‌شده برمی‌گردد
    useEffect(() => {
        if (!open) return
        setReminder(defaultReminderDraft(selectedDate))
    }, [open, selectedDate])

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
    // قرارداد صف آفلاین V1 تغییر نمی‌کند: فقط {title, scheduledDate}. یادآوری در آفلاین ذخیره نمی‌شود.
    const saveOffline = (value: string) => {
        enqueueTask({
            title: value,
            dayKey: selectedDate,
            scheduledDate: canonicalKeyToLocalMidnight(selectedDate, timezone).toISOString(),
        })
        if (reminder.enabled) {
            toast.info("در حالت آفلاین یادآوری ذخیره نمی‌شود؛ بعد از اتصال دوباره تنظیمش کن")
        }
        toast.info(`${<Unplug />} آفلاین هستی — کار ذخیره شد و بعد از اتصال سینک می‌شود`)
        setText("")
        onClose()
        onCreated()
    }

    const submit = async () => {
        if (text.trim().length < 3) {
            toast.error("عنوان باید حداقل ۳ حرف باشد")
            return
        }
        const value = text.trim()

        if (isOffline()) {
            saveOffline(value)
            return
        }

        setLoading(true)
        try {
            await api("/api/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: value,
                    scheduledDate: canonicalKeyToLocalMidnight(selectedDate, timezone).toISOString(),
                    // instant مطلق یادآوری (null = بدون یادآوری) — تبدیل در همین‌جا با timezone کاربر
                    reminderAt: reminder.enabled
                        ? reminderInstantFromLocal(reminder.canonicalKey, reminder.hour, reminder.minute, timezone).toISOString()
                        : null,
                }),
            })

            setText("")
            onClose()
            onCreated()
            toast.success("کار ساخته شد و زمان‌بندی شد ✅")
        } catch (e) {
            /* خطای شبکه حین ارسال → ذخیره در صف آفلاین */
            if (e instanceof TypeError) {
                saveOffline(value)
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
                — کار بدون تحلیل ساخته میشه
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
            <TaskReminderField value={reminder} onChange={setReminder} disabled={loading} />
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
