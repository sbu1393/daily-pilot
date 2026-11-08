"use client"

import { faDigits } from "@/app/lib/time"
import {
    JALALI_MONTH_NAMES,
    daysInJalaliMonth,
    datetimeLocalValueToJalaliDateTimeParts,
    epochMsToJalaliDateTimeParts,
    jalaliDateTimePartsToDatetimeLocalValue,
    type JalaliDateTimeParts,
} from "./jalaliDateTime"
import styles from "./reminder.module.css"

/*
 * انتخابگر تاریخ/ساعت شمسی برای آلارم تسک.
 *
 * مقدار ورودی/خروجی همان `YYYY-MM-DDTHH:mm` میلادی و وقت محلی دستگاه است؛
 * کنترل فقط لایه‌ی نمایش است. ساعت ۲۴ساعته و بدون AM/PM نمایش داده می‌شود تا
 * با `formatReminderTime` و صفحه‌ی بومی `HH:mm` هماهنگ باشد.
 */

type Props = {
    value: string
    onChange: (value: string) => void
    disabled?: boolean
    labelledBy?: string
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

const pad2 = (n: number) => String(n).padStart(2, "0")

export default function JalaliDateTimePicker({
    value,
    onChange,
    disabled = false,
    labelledBy,
}: Props) {
    /*
     * مودال همیشه مقدار معتبر می‌دهد؛ این fallback فقط برای دفاع در برابر
     * مقدار خراب است تا کنترل به‌جای خالی‌شدن، قابل استفاده بماند.
     */
    const parts =
        datetimeLocalValueToJalaliDateTimeParts(value) ??
        epochMsToJalaliDateTimeParts(Date.now())

    const current = epochMsToJalaliDateTimeParts(Date.now())
    const baseYears = Array.from({ length: 12 }, (_, i) => current.year - 1 + i)
    /* اگر آلارمِ موجود بیرون از این بازه باشد، سالش هم در لیست بماند. */
    const years = baseYears.includes(parts.year)
        ? baseYears
        : [...baseYears, parts.year].sort((a, b) => a - b)
    const dayCount = daysInJalaliMonth(parts.year, parts.month)

    const commit = (patch: Partial<JalaliDateTimeParts>) => {
        const next: JalaliDateTimeParts = { ...parts, ...patch }

        /* تغییر ماه/سال می‌تواند روز را از محدوده خارج کند (۳۱ شهریور → مهر). */
        next.day = Math.min(next.day, daysInJalaliMonth(next.year, next.month))

        const nextValue = jalaliDateTimePartsToDatetimeLocalValue(next)
        if (nextValue) onChange(nextValue)
    }

    return (
        <div
            className={styles.picker}
            role="group"
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : "تاریخ و ساعت آلارم"}
        >
            <div className={styles.pickerDate}>
                <select
                    className={styles.pickerSelect}
                    aria-label="روز"
                    value={parts.day}
                    onChange={(e) => commit({ day: Number(e.target.value) })}
                    disabled={disabled}
                >
                    {Array.from({ length: dayCount }, (_, i) => i + 1).map((day) => (
                        <option key={day} value={day}>
                            {faDigits(day)}
                        </option>
                    ))}
                </select>

                <select
                    className={styles.pickerSelect}
                    aria-label="ماه"
                    value={parts.month}
                    onChange={(e) => commit({ month: Number(e.target.value) })}
                    disabled={disabled}
                >
                    {JALALI_MONTH_NAMES.map((name, index) => (
                        <option key={name} value={index + 1}>
                            {name}
                        </option>
                    ))}
                </select>

                <select
                    className={styles.pickerSelect}
                    aria-label="سال"
                    value={parts.year}
                    onChange={(e) => commit({ year: Number(e.target.value) })}
                    disabled={disabled}
                >
                    {years.map((year) => (
                        <option key={year} value={year}>
                            {faDigits(year)}
                        </option>
                    ))}
                </select>
            </div>

            {/* جهت LTR تا ساعت همیشه سمت چپ و دقیقه سمت راست دیده شود. */}
            <div className={styles.pickerTime} dir="ltr">
                <select
                    className={styles.pickerSelect}
                    aria-label="ساعت"
                    value={parts.hour}
                    onChange={(e) => commit({ hour: Number(e.target.value) })}
                    disabled={disabled}
                >
                    {HOURS.map((hour) => (
                        <option key={hour} value={hour}>
                            {faDigits(pad2(hour))}
                        </option>
                    ))}
                </select>

                <span className={styles.pickerColon} aria-hidden="true">
                    :
                </span>

                <select
                    className={styles.pickerSelect}
                    aria-label="دقیقه"
                    value={parts.minute}
                    onChange={(e) => commit({ minute: Number(e.target.value) })}
                    disabled={disabled}
                >
                    {MINUTES.map((minute) => (
                        <option key={minute} value={minute}>
                            {faDigits(pad2(minute))}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    )
}
