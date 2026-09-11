"use client"

import { useEffect, useState } from "react"
import "./Splash.css"

/**
 * صفحه‌ی شروع (Startup Splash) — از اولین بایتِ HTML دیده می‌شود
 * (چون در SSR هم رندر می‌شود) و بعد از hydrate شدن React حذف می‌گردد.
 * Full Logo «روزچین» با متن واضح؛ آیکن موبایل در این تجربه نمایش داده نمیشود.
 */
export default function Splash() {
    const [visible, setVisible] = useState(true)

    useEffect(() => {
        setVisible(false)
    }, [])

    if (!visible) return null

    return (
        <div id="dp-splash" aria-hidden="true">
            <img src="/animated-logo.gif" alt="روزچین" />
        </div>
    )
}
