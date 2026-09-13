"use client"

import { useEffect, useState, type CSSProperties } from "react"
import "./Splash.css"

// مدت زمان نمایش به میلی‌ثانیه (۲.۲ ثانیه برای دیدن کامل گیف)
const SPLASH_DURATION_MS = 2200
// زمان محو شدن تدریجی (Fade-out)
const SPLASH_FADE_MS = 200

export default function Splash() {
    const [visible, setVisible] = useState(true)

    useEffect(() => {
        // بررسی اینکه آیا کاربر ترجیح داده انیمیشن‌ها خاموش/کم باشن یا نه
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        
        // تایمر برای حذف کامل کامپوننت از صفحه بعد از پایان زمان نمایش + زمان انیمیشن
        const timerId = window.setTimeout(
            () => setVisible(false),
            SPLASH_DURATION_MS + (reduce ? 0 : SPLASH_FADE_MS)
        )

        // تمیزکاری تایمر در صورت بستن صفحه یا رندر مجدد در StrictMode
        return () => window.clearTimeout(timerId)
    }, [])

    if (!visible) return null

    // ارسال مقادیر زمان به عنوان متغیر به CSS
    const style = {
        "--dp-splash-duration": `${SPLASH_DURATION_MS}ms`,
        "--dp-splash-fade-duration": `${SPLASH_FADE_MS}ms`,
    } as CSSProperties

    return (
        <div id="dp-splash" aria-hidden="true" style={style}>
            <img src="/animated-logo.gif" alt="روزچین" />
        </div>
    )
}
