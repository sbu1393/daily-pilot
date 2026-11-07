"use client"

import { useEffect, useRef } from "react"

/**
 * رجیستری سراسری overlayها برای دکمهٔ بازگشت اندروید.
 *
 * هر مدال/منو/دراورِ باز، یک handler «بستن» ثبت می‌کند. هنگام فشردن دکمهٔ
 * بازگشت سخت‌افزاری، ابتدا handler آخرین overlay باز (بالاترین لایه) صدا زده
 * می‌شود؛ اگر هیچ overlayای باز نبود، نوبت به ناوبری/خروج می‌رسد.
 */

type BackCloseHandler = () => void

type Entry = {
    id: number
    close: BackCloseHandler
}

let nextId = 1
const entries: Entry[] = []

/**
 * تا زمانی که `open` true است، `onClose` را به‌عنوان handler دکمهٔ بازگشت ثبت
 * می‌کند. آخرین overlayی که باز شود، اولین چیزی است که بسته می‌شود.
 */
export function useBackButtonClose(open: boolean, onClose: () => void) {
    const closeRef = useRef(onClose)

    useEffect(() => {
        closeRef.current = onClose
    }, [onClose])

    useEffect(() => {
        if (!open) return

        const id = nextId++
        entries.push({ id, close: () => closeRef.current() })

        return () => {
            const index = entries.findIndex((entry) => entry.id === id)
            if (index !== -1) entries.splice(index, 1)
        }
    }, [open])
}

/** بالاترین overlay باز را می‌بندد. اگر چیزی باز باشد true برمی‌گرداند. */
export function closeTopOverlay(): boolean {
    const top = entries[entries.length - 1]
    if (!top) return false
    top.close()
    return true
}

/** فقط برای تست/دیباگ: آیا overlay بازی ثبت شده است؟ */
export function hasOpenOverlay(): boolean {
    return entries.length > 0
}
