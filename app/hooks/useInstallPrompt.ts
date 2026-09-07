"use client"

import { useCallback, useEffect, useState } from "react"

type BeforeInstallPromptEvent = Event & {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

/**
 * هوک نصب PWA — رویداد beforeinstallprompt را گرفته و نگه می‌دارد.
 * - canInstall: مرورگر پنجره نصب نمایش می‌دهد (کروم/ادج/اندروید/دسکتاپ)
 * - isStandalone: برنامه همین حالا نصب شده است
 * - promptInstall: باز کردن پنجره نصب بومی
 */
export function useInstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
    const [isStandalone, setIsStandalone] = useState(false)

    useEffect(() => {
        const handler = (e: Event) => {
            e.preventDefault() // جلوگیری از پاپ‌آپ خودکار مرورگر
            setDeferredPrompt(e as BeforeInstallPromptEvent)
        }

        const checkStandalone = () => {
            setIsStandalone(
                window.matchMedia("(display-mode: standalone)").matches ||
                    (window.navigator as unknown as { standalone?: boolean }).standalone === true, // iOS Safari
            )
        }

        checkStandalone()
        window.addEventListener("beforeinstallprompt", handler)
        window.addEventListener("appinstalled", checkStandalone)
        window.matchMedia("(display-mode: standalone)").addEventListener("change", checkStandalone)

        return () => {
            window.removeEventListener("beforeinstallprompt", handler)
            window.removeEventListener("appinstalled", checkStandalone)
            window.matchMedia("(display-mode: standalone)").removeEventListener("change", checkStandalone)
        }
    }, [])

    const promptInstall = useCallback(async () => {
        if (!deferredPrompt) return false
        await deferredPrompt.prompt()
        const { outcome } = await deferredPrompt.userChoice
        setDeferredPrompt(null) // رویداد فقط یک‌بار قابل استفاده است
        return outcome === "accepted"
    }, [deferredPrompt])

    return {
        canInstall: deferredPrompt !== null,
        isStandalone,
        promptInstall,
    }
}
