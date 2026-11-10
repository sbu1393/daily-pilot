"use client"

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
} from "react"

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
 * انتخابگر تاریخ/ساعت شمسی برای آلارم تسک — چرخ‌های لمسی/اسکرولی.
 *
 * مقدار ورودی/خروجی همان `YYYY-MM-DDTHH:mm` میلادی و وقت محلی دستگاه است؛
 * این فایل فقط لایه‌ی نمایش است و هیچ تبدیلی را تغییر نمی‌دهد. ساعت ۲۴ساعته و
 * بدون AM/PM است تا با `formatReminderTime` و صفحه‌ی بومی `HH:mm` هماهنگ بماند.
 */

type Props = {
    value: string
    onChange: (value: string) => void
    disabled?: boolean
    labelledBy?: string
}

/** هم‌گام با `--wheel-item` در reminder.module.css */
const WHEEL_ITEM_HEIGHT = 36

/**
 * فقط برای مرورگرهایی که `scrollend` ندارند؛ با هر رویداد scroll ریست می‌شود
 * تا مقدار میانیِ حین momentum ثبت نشود.
 */
const SCROLL_COMMIT_DELAY_MS = 110

/** در سرور از useEffect استفاده می‌شود تا هشدار useLayoutEffect ندهیم. */
const useIsomorphicLayoutEffect =
    typeof window !== "undefined" ? useLayoutEffect : useEffect

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

const pad2 = (n: number) => String(n).padStart(2, "0")

type WheelOption = {
    value: number
    label: string
}

const MONTH_OPTIONS: WheelOption[] = JALALI_MONTH_NAMES.map((name, index) => ({
    value: index + 1,
    label: name,
}))

const HOUR_OPTIONS: WheelOption[] = HOURS.map((hour) => ({
    value: hour,
    label: faDigits(pad2(hour)),
}))

const MINUTE_OPTIONS: WheelOption[] = MINUTES.map((minute) => ({
    value: minute,
    label: faDigits(pad2(minute)),
}))

type WheelProps = {
    label: string
    options: WheelOption[]
    value: number
    onChange: (value: number) => void
    disabled?: boolean
}

/**
 * یک ستون چرخان: اسکرول عمودی با snap؛ آیتم وسط به‌عنوان مقدار انتخاب‌شده
 * خوانده می‌شود. کلیک و کلیدهای جهت‌دار هم برای دسترس‌پذیری پشتیبانی می‌شوند.
 *
 * مقدار انتخاب‌شده در حین اسکرول به‌صورت محلی (برای هایلایت) به‌روز می‌شود،
 * اما onChange فقط پس از توقف کامل اسکرول (`scrollend` یا debounce) صدا زده
 * می‌شود تا مقادیر میانیِ momentum به والد نرسند.
 */
function Wheel({ label, options, value, onChange, disabled = false }: WheelProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const selectedIndex = Math.max(
        0,
        options.findIndex((option) => option.value === value),
    )

    /* مقدار وسط در حین اسکرول؛ والد (value) ممکن است هنوز مقدار قبلی باشد. */
    const [activeIndex, setActiveIndex] = useState(selectedIndex)
    const activeIndexRef = useRef(selectedIndex)

    /* تازه‌ترین مقادیر برای callbackهای async (تایمر/scrollend). */
    const optionsRef = useRef(options)
    const valueRef = useRef(value)
    const onChangeRef = useRef(onChange)

    useEffect(() => {
        optionsRef.current = options
        valueRef.current = value
        onChangeRef.current = onChange
    }, [options, value, onChange])

    const scrollToIndex = useCallback((index: number) => {
        const el = scrollRef.current
        if (!el) return

        const target = index * WHEEL_ITEM_HEIGHT
        if (Math.abs(el.scrollTop - target) < 1) return

        el.scrollTop = target
    }, [])

    const clearCommitTimer = useCallback(() => {
        if (commitTimerRef.current == null) return

        clearTimeout(commitTimerRef.current)
        commitTimerRef.current = null
    }, [])

    const commitIndex = useCallback((index: number) => {
        const option = optionsRef.current[index]
        if (!option || option.value === valueRef.current) return

        onChangeRef.current(option.value)
    }, [])

    /**
     * مقدار وسط را از خود DOM می‌خواند؛ برای `scrollend` و تایمر fallback.
     * اگر مقدار همان مقدار والد باشد، onChange دوباره صدا زده نمی‌شود.
     */
    const commitFromDom = useCallback(() => {
        const el = scrollRef.current
        if (!el) return

        const index = Math.min(
            optionsRef.current.length - 1,
            Math.max(0, Math.round(el.scrollTop / WHEEL_ITEM_HEIGHT)),
        )

        activeIndexRef.current = index
        setActiveIndex(index)
        clearCommitTimer()
        commitIndex(index)
    }, [clearCommitTimer, commitIndex])

    /* ارجاع پایدار برای listener بومی `scrollend` */
    const commitFromDomRef = useRef(commitFromDom)
    useEffect(() => {
        commitFromDomRef.current = commitFromDom
    }, [commitFromDom])

    /**
     * همگام‌سازی با مقدار خارجی (باز شدن مودال، آلارم ذخیره‌شده، انتخاب سریع،
     * یا clamp شدن روز بعد از تغییر ماه/سال). فقط وقتی مقدار انتخابیِ واقعی
     * تغییر کرده باشد اسکرول را جابه‌جا می‌کند. layout effect است تا موقعیت
     * ذخیره‌شده پیش از اولین رنگ‌آمیزی اعمال شود و پرش اولیه دیده نشود.
     */
    useIsomorphicLayoutEffect(() => {
        const el = scrollRef.current
        if (!el) return

        const nearest = Math.round(el.scrollTop / WHEEL_ITEM_HEIGHT)
        if (activeIndexRef.current === selectedIndex && nearest === selectedIndex) return

        clearCommitTimer()
        activeIndexRef.current = selectedIndex
        setActiveIndex(selectedIndex)
        scrollToIndex(selectedIndex)
    }, [selectedIndex, clearCommitTimer, scrollToIndex])

    /* debounce fallback؛ در WebViewهای قدیمی که scrollend ندارند */
    const scheduleCommit = useCallback(() => {
        clearCommitTimer()
        commitTimerRef.current = setTimeout(() => {
            commitTimerRef.current = null
            commitFromDom()
        }, SCROLL_COMMIT_DELAY_MS)
    }, [clearCommitTimer, commitFromDom])

    useEffect(() => {
        const el = scrollRef.current
        if (!el) return

        const handleScrollEnd = () => commitFromDomRef.current()
        el.addEventListener("scrollend", handleScrollEnd)

        return () => el.removeEventListener("scrollend", handleScrollEnd)
    }, [])

    useEffect(() => {
        return () => clearCommitTimer()
    }, [clearCommitTimer])

    useEffect(() => {
        if (disabled) clearCommitTimer()
    }, [disabled, clearCommitTimer])

    const selectIndex = (index: number) => {
        clearCommitTimer()
        activeIndexRef.current = index
        setActiveIndex(index)
        scrollToIndex(index)
        commitIndex(index)
    }

    const handleScroll = () => {
        if (disabled) return

        const el = scrollRef.current
        if (!el) return

        const index = Math.min(
            options.length - 1,
            Math.max(0, Math.round(el.scrollTop / WHEEL_ITEM_HEIGHT)),
        )

        if (index !== activeIndexRef.current) {
            activeIndexRef.current = index
            setActiveIndex(index)
        }

        scheduleCommit()
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return

        /* مبنای حرکت کلید، آیتم وسط است؛ ممکن است هنوز commit نشده باشد. */
        let nextIndex = activeIndexRef.current

        switch (event.key) {
            case "ArrowUp":
                nextIndex -= 1
                break
            case "ArrowDown":
                nextIndex += 1
                break
            case "PageUp":
                nextIndex -= 5
                break
            case "PageDown":
                nextIndex += 5
                break
            case "Home":
                nextIndex = 0
                break
            case "End":
                nextIndex = options.length - 1
                break
            default:
                return
        }

        event.preventDefault()
        nextIndex = Math.min(options.length - 1, Math.max(0, nextIndex))
        selectIndex(nextIndex)
    }

    return (
        <div className={`${styles.wheelColumn} ${disabled ? styles.wheelDisabled : ""}`}>
            <span className={styles.wheelLabel}>{label}</span>

            <div className={styles.wheelBox}>
                <span className={styles.wheelHighlight} aria-hidden="true" />

                <div
                    ref={scrollRef}
                    className={styles.wheel}
                    role="listbox"
                    aria-label={label}
                    aria-orientation="vertical"
                    aria-disabled={disabled || undefined}
                    tabIndex={disabled ? -1 : 0}
                    onScroll={handleScroll}
                    onKeyDown={handleKeyDown}
                >
                    {options.map((option, index) => (
                        <div
                            key={option.value}
                            className={styles.wheelItem}
                            role="option"
                            aria-selected={index === activeIndex}
                            onClick={() => {
                                if (!disabled) selectIndex(index)
                            }}
                        >
                            {option.label}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}

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
    const yearValues = baseYears.includes(parts.year)
        ? baseYears
        : [...baseYears, parts.year].sort((a, b) => a - b)

    const dayCount = daysInJalaliMonth(parts.year, parts.month)

    const dayOptions: WheelOption[] = Array.from({ length: dayCount }, (_, i) => ({
        value: i + 1,
        label: faDigits(i + 1),
    }))

    const yearOptions: WheelOption[] = yearValues.map((year) => ({
        value: year,
        label: faDigits(year),
    }))

    const commit = (patch: Partial<JalaliDateTimeParts>) => {
        const next: JalaliDateTimeParts = { ...parts, ...patch }

        /* تغییر ماه/سال می‌تواند روز را از محدوده خارج کند (۳۱ شهریور → مهر). */
        next.day = Math.min(next.day, daysInJalaliMonth(next.year, next.month))

        const nextValue = jalaliDateTimePartsToDatetimeLocalValue(next)
        if (nextValue) onChange(nextValue)
    }

    return (
        <div
            className={styles.pickerWheels}
            role="group"
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : "تاریخ و ساعت آلارم"}
        >
            {/* چیدمان RTL → از چپ به راست: سال، ماه، روز */}
            <div className={styles.pickerDateWheels}>
                <Wheel
                    label="روز"
                    options={dayOptions}
                    value={parts.day}
                    onChange={(day) => commit({ day })}
                    disabled={disabled}
                />
                <Wheel
                    label="ماه"
                    options={MONTH_OPTIONS}
                    value={parts.month}
                    onChange={(month) => commit({ month })}
                    disabled={disabled}
                />
                <Wheel
                    label="سال"
                    options={yearOptions}
                    value={parts.year}
                    onChange={(year) => commit({ year })}
                    disabled={disabled}
                />
            </div>

            {/* جهت LTR تا ساعت سمت چپ و دقیقه سمت راست دیده شود. */}
            <div className={styles.pickerTimeWheels} dir="ltr">
                <Wheel
                    label="ساعت"
                    options={HOUR_OPTIONS}
                    value={parts.hour}
                    onChange={(hour) => commit({ hour })}
                    disabled={disabled}
                />

                <span className={styles.pickerColon} aria-hidden="true">
                    :
                </span>

                <Wheel
                    label="دقیقه"
                    options={MINUTE_OPTIONS}
                    value={parts.minute}
                    onChange={(minute) => commit({ minute })}
                    disabled={disabled}
                />
            </div>
        </div>
    )
}
