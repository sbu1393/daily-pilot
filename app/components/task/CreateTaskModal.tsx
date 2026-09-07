"use client"

import { useEffect, useState } from "react"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { faDigits } from "@/app/lib/time"
import { enqueueTask, isOffline } from "@/app/lib/offline"
import { toast } from "react-toastify"
import AnimatedModal from "../motion/AnimatedModal"
import styles from "./task.module.css"

type Props = {
    open: boolean
    onClose: () => void
    onCreated: () => void
}

export default function CreateTaskModal({ open, onClose, onCreated }: Props) {
    const { selectedDate } = useCalendar()
    const [text, setText] = useState("")
    const [loading, setLoading] = useState(false)
    const [offline, setOffline] = useState(false)

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
    const saveOffline = (value: string) => {
        enqueueTask({ text: value, dayKey: selectedDate })
        toast.info("🔌 آفلاین هستی — تسک ذخیره شد و بعد از اتصال، سینک و تحلیل می‌شود")
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
            const res = await fetch("/api/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: value, dayKey: selectedDate }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error((json as { message?: string }).message || "خطا در ساخت تسک")

            setText("")
            onClose()
            onCreated()

            if ((json as { aiSource?: string }).aiSource === "mock") {
                toast.info("هوش مصنوعی در دسترس نبود؛ تحلیل آزمایشی اعمال شد")
            } else {
                toast.success("تسک ساخته شد و زمان‌بندی شد ✅")
            }
        } catch (e) {
            /* خطای شبکه حین ارسال → ذخیره در صف آفلاین */
            if (e instanceof TypeError) {
                saveOffline(value)
            } else {
                toast.error(e instanceof Error ? e.message : "خطا در ساخت تسک")
            }
        } finally {
            setLoading(false)
        }
    }

    return (
        <AnimatedModal open={open} onClose={onClose}>
            <div className={styles.modalHead}>
                <h4>تسک جدید</h4>                    <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">✕</button>
            </div>
            {offline && (
                <div className="dp-queued-chip" style={{ justifyContent: "center" }}>
                    🔌 آفلاین — تسک محلی ذخیره و بعداً سینک می‌شود
                </div>
            )}
            <p className={styles.hint}>
                برای روز <b>{faDigits(selectedDate.replaceAll("-", "/"))}</b> — هوش مصنوعی اولویت، امتیاز،
                دلیل و زمان تخمینی را مشخص می‌کند.
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
            <div className={styles.modalActions}>
                <button className={styles.btnPrimary} onClick={submit} disabled={loading}>
                    {loading ? "⏳ در حال تحلیل با هوش مصنوعی…" : "تحلیل و ساخت تسک"}
                </button>
                <button className={styles.btnGhost} onClick={onClose} disabled={loading}>
                    انصراف
                </button>
            </div>
        </AnimatedModal>
    )
}
