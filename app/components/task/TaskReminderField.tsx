"use client"

import moment from "moment-jalaali"
import { toast } from "react-toastify"
import { faDigits } from "@/app/lib/time"
import { useSettings } from "@/app/contexts/SettingsContext"
import { subscribeToPush } from "@/app/lib/push/client"
import { canonicalKeyToJalali, jalaliToCanonicalKey } from "@/app/components/calender/jalaliDate"

/**
 * فیلد مشترک یادآوری per-task.
 * - تاریخ: تقویم شمسی (روز/ماه/سال جلالی)
 * - ساعت: ۲۴ ساعته با ارقام فارسی (بدون AM/PM)
 * - مقدار فقط presentation است؛ تبدیل به instant در والد انجام می‌شود.
 */

export type ReminderDraft = {
    enabled: boolean
    canonicalKey: string // روز محلی canonical "YYYY-MM-DD"
    hour: number // ۰..۲۳
    minute: number // ۰..۵۹
}

const J_MONTHS = [
    "فروردین",
    "اردیبهشت",
    "خرداد",
    "تیر",
    "مرداد",
    "شهریور",
    "مهر",
    "آبان",
    "آذر",
    "دی",
    "بهمن",
    "اسفند",
]

const HOURS_24 = Array.from({ length: 24 }, (_, i) => i)
const MINUTES_60 = Array.from({ length: 60 }, (_, i) => i)

const pad2 = (n: number) => String(n).padStart(2, "0")

export function defaultReminderDraft(selectedDate: string): ReminderDraft {
    return { enabled: false, canonicalKey: selectedDate, hour: 9, minute: 0 }
}

type Props = {
    value: ReminderDraft
    onChange: (next: ReminderDraft) => void
    disabled?: boolean
}

export default function TaskReminderField({ value, onChange, disabled }: Props) {
    const { requestNotificationPermission } = useSettings()

    const j = canonicalKeyToJalali(value.canonicalKey || "2026-01-01")
    const jYearNow = moment().jYear()
    const jDayCount = moment.jDaysInMonth(j.year, j.month - 1)

    const setEnabled = async (enabled: boolean) => {
        if (!enabled) {
            onChange({ ...value, enabled: false })
            return
        }
        onChange({ ...value, enabled: true })
        // درخواست مجوز فقط در لحظه‌ی فعال‌سازی یادآوری (نه با باز شدن صفحه)
        const granted = await requestNotificationPermission()
        if (!granted) {
            toast.info("برای دریافت یادآوری، اجازه‌ی اعلان‌های مرورگر را فعال کنید.")
        } else {
            // ADR-07 — در همین نقطه‌ی صریح UX، اشتراک Web Push به‌صورت best-effort ثبت می‌شود.
            // هیچ ارسال/Scheduler این‌جا نیست؛ شکست آن بی‌صدا رد می‌شود (بدون تغییر رفتار فعلی).
            void subscribeToPush()
        }
    }

    const setJalali = (part: "year" | "month" | "day", raw: string) => {
        const num = Number(raw)
        let { year, month, day } = j
        if (part === "year") year = num
        if (part === "month") month = num
        if (part === "day") day = num
        const days = moment.jDaysInMonth(year, month - 1)
        if (day > days) day = days
        onChange({ ...value, canonicalKey: jalaliToCanonicalKey(year, month, day) })
    }

    return (
        <div className="dp-field" style={{ marginTop: 4 }}>
            <label
                className="dp-field-label"
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: disabled ? "default" : "pointer" }}
            >
                <input
                    type="checkbox"
                    checked={value.enabled}
                    disabled={disabled}
                    onChange={(e) => void setEnabled(e.target.checked)}
                />
                یادآوری برای این تسک فعال باشد
            </label>

            {value.enabled && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    <select
                        className="dp-input"
                        aria-label="روز یادآوری"
                        value={j.day}
                        disabled={disabled}
                        onChange={(e) => setJalali("day", e.target.value)}
                        style={{ flex: "1 1 0", minWidth: "4.5rem" }}
                    >
                        {Array.from({ length: jDayCount }, (_, i) => i + 1).map((d) => (
                            <option key={d} value={d}>{faDigits(d)}</option>
                        ))}
                    </select>
                    <select
                        className="dp-input"
                        aria-label="ماه یادآوری"
                        value={j.month}
                        disabled={disabled}
                        onChange={(e) => setJalali("month", e.target.value)}
                        style={{ flex: "1 1 0", minWidth: "6rem" }}
                    >
                        {J_MONTHS.map((name, i) => (
                            <option key={i + 1} value={i + 1}>{name}</option>
                        ))}
                    </select>
                    <select
                        className="dp-input"
                        aria-label="سال یادآوری"
                        value={j.year}
                        disabled={disabled}
                        onChange={(e) => setJalali("year", e.target.value)}
                        style={{ flex: "1 1 0", minWidth: "5rem" }}
                    >
                        {[jYearNow, jYearNow + 1, jYearNow + 2].map((y) => (
                            <option key={y} value={y}>{faDigits(y)}</option>
                        ))}
                    </select>

                    <select
                        className="dp-input"
                        aria-label="ساعت یادآوری"
                        value={value.hour}
                        disabled={disabled}
                        onChange={(e) => onChange({ ...value, hour: Number(e.target.value) })}
                        style={{ flex: "1 1 0", minWidth: "4.5rem" }}
                    >
                        {HOURS_24.map((h) => (
                            <option key={h} value={h}>{faDigits(pad2(h))}</option>
                        ))}
                    </select>
                    <select
                        className="dp-input"
                        aria-label="دقیقه یادآوری"
                        value={value.minute}
                        disabled={disabled}
                        onChange={(e) => onChange({ ...value, minute: Number(e.target.value) })}
                        style={{ flex: "1 1 0", minWidth: "4.5rem" }}
                    >
                        {MINUTES_60.map((m) => (
                            <option key={m} value={m}>{faDigits(pad2(m))}</option>
                        ))}
                    </select>
                </div>
            )}

            {value.enabled && (
                <p className="dp-ai-missing" style={{ marginTop: 6 }}>
                    تاریخ و ساعت به‌صورت شمسی و ۲۴ ساعته است. اعلان فقط در هنگام باز بودن برنامه ارسال می‌شود.
                </p>
            )}
        </div>
    )
}
