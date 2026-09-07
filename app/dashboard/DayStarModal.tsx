"use client"

import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { todayKey } from "../lib/jalili"
import { faDigits } from "@/app/lib/time"
import AnimatedModal from "../components/motion/AnimatedModal"
import styles from "./dashboard.module.css"

const PRESETS = [
    { label: "۱ ساعت", value: 60 },
    { label: "۲ ساعت", value: 120 },
    { label: "۳ ساعت", value: 180 },
    { label: "۴ ساعت", value: 240 },
    { label: "۶ ساعت", value: 360 },
    { label: "۸ ساعت", value: 480 },
]

export default function DayStartModal({
    open,
    isEdit = false, 
    initialMinutes = 240,
    required = false,
    onClose,
    onSaved,
}: {
    open: boolean
    isEdit?: boolean
    initialMinutes?: number
    required?: boolean         
    onClose: () => void
    onSaved: (json: unknown) => void
}) {
    const { selectedDate } = useCalendar()
    const [minutes, setMinutes] = useState(initialMinutes)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (open) setMinutes(initialMinutes)
    }, [open, initialMinutes])

    if (!open) return null

    const isToday = selectedDate === todayKey()

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!minutes || minutes <= 0) {
            setError("یک مقدار معتبر وارد کن")
            return
        }
        setLoading(true)
        setError(null)
        try {
            const res = await fetch("/api/planner/day", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dayKey: selectedDate, availableMinutes: minutes }),
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json.message || "خطا در ثبت وقت روز")
            onSaved(json)
            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : "خطای ناشناخته")
        } finally {
            setLoading(false)
        }
    }

    return (
        <AnimatedModal open={open} onClose={onClose}>
            <div className={styles.modalCard}>
                <div className={styles.modalHead}>
                    <h3>
                        {isEdit
                            ? "ویرایش وقت روز"
                            : isToday
                                ? "امروز چقدر وقت داری؟"
                                : "برای این روز چقدر وقت می‌ذاری؟"}
                    </h3>
                    <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">
                        <X size={18} />
                    </button>
                </div>

                <p className={styles.modalSub}>
                    بر اساس این بودجه، هوش مصنوعی زمان هر کار رو تخمین می‌زنه و بین تسک‌ها تخصیص می‌ده.
                </p>

                <form onSubmit={submit}>
                    <div className={styles.presetRow}>
                        {PRESETS.map((p) => (
                            <button
                                key={p.value}
                                type="button"
                                className={`${styles.preset} ${minutes === p.value ? styles.presetActive : ""}`}
                                onClick={() => {
                                    setMinutes(p.value)
                                    setError(null)
                                }}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>

                    <input
                        type="number"
                        min={1}
                        max={1440}
                        className={styles.minuteInput}
                        value={minutes || ""}
                        onChange={(e) => setMinutes(Number(e.target.value))}
                        placeholder="مثلاً ۲۴۰"
                    />
                    <div className={styles.modalSub} style={{ marginTop: -8 }}>
                        {faDigits(minutes || 0)} دقیقه
                    </div>

                    {error && <div className={styles.formError}>{error}</div>}

                    <button type="submit" className={styles.btnPrimary} disabled={loading}>
                        {loading ? "در حال ثبت..." : isEdit ? "ذخیره تغییرات" : "شروع روز"}
                    </button>
                </form>
            </div>
        </AnimatedModal>
    )
}
