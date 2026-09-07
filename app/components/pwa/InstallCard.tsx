"use client"

import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { Download, QrCode, Smartphone } from "lucide-react"
import { useInstallPrompt } from "@/app/hooks/useInstallPrompt"
import { toast } from "react-toastify"

/**
 * کارت «نصب روی گوشی» — کد QR آدرس فعلی را نشان می‌دهد تا با دوربین گوشی
 * اسکن شود، و اگر مرورگر پشتیبانی کند دکمه نصب مستقیم هم ارائه می‌دهد.
 * سازگار با اندروید (کروم)، iOS (Safari → Add to Home Screen)، و دسکتاپ.
 */
export default function InstallCard() {
    const { canInstall, isStandalone, promptInstall } = useInstallPrompt()
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
    const [platform, setPlatform] = useState<"ios" | "other">("other")

    const shareUrl = typeof window !== "undefined" ? window.location.origin : ""

    useEffect(() => {
        // تولید QR سمت کلاینت (ویندوز/تبلت/گوشی — بدون بار سرور)
        QRCode.toDataURL(shareUrl, {
            width: 200,
            margin: 1,
            color: { dark: "#1e1b4b", light: "#ffffff" },
            errorCorrectionLevel: "M",
        })
            .then(setQrDataUrl)
            .catch(() => setQrDataUrl(null))

        setPlatform(/iphone|ipad|ipod/i.test(window.navigator.userAgent) ? "ios" : "other")
    }, [shareUrl])

    // کاربر از داخل خود اپ آمده → نصب انجام شده
    if (isStandalone) {
        return (
            <div className="dp-card-soft">
                <h3 className="dp-card-title">✅ برنامه نصب شده است</h3>
                <p className="dp-card-text">
                    Daily Pilot روی این دستگاه نصب است و مثل یک اپ بومی اجرا می‌شود. از همین‌جا با یک لمس
                    به برنامه‌ریزی روز بپرداز!
                </p>
            </div>
        )
    }

    const install = async () => {
        const accepted = await promptInstall()
        if (accepted) {
            toast.success("نصب انجام شد؛ آیکون Daily Pilot روی گوشی‌ات اضافه شد 🎉")
        } else {
            toast.info("می‌توانی بعداً از منوی مرورگر نصب کنی")
        }
    }

    return (
        <div className="dp-card-soft">
            <h3 className="dp-card-title">
                <QrCode size={20} /> نصب روی گوشی
            </h3>
            <p className="dp-card-text">
                با دوربین گوشی کد زیر را اسکن کن یا لینک را روی گوشی باز کن تا Daily Pilot مثل یک اپ
                واقعی نصب شود — آیکون روی صفحه اصلی، اجرای تمام‌صفحه و کارکرد آفلاین.
            </p>

            <div className="dp-install-grid">
                <div className="dp-qr-wrap">
                    {qrDataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={qrDataUrl} alt="کد QR نصب Daily Pilot" className="dp-qr-img" />
                    ) : (
                        <div className="dp-qr-placeholder">در حال ساخت کد…</div>
                    )}
                    <span className="dp-qr-url">{shareUrl}</span>
                </div>

                <div className="dp-install-steps">
                    {platform === "ios" ? (
                        <ol className="dp-steps">
                            <li>در Safari دکمه اشتراک <b>(Share)</b> را بزن</li>
                            <li><b>Add to Home Screen</b> را انتخاب کن</li>
                            <li><b>Add</b> را بزن — تمام شد ✨</li>
                        </ol>
                    ) : (
                        <ol className="dp-steps">
                            <li>لینک را در Chrome باز کن</li>
                            <li>از منوی سه‌نقطه <b>Install app</b> را انتخاب کن</li>
                            <li>یا دکمه زیر را بزن — سریع‌تر است 👇</li>
                        </ol>
                    )}

                    {canInstall && (
                        <button type="button" className="dp-btn dp-btn-primary dp-btn-block" onClick={install}>
                            <Download size={16} /> نصب مستقیم روی این دستگاه
                        </button>
                    )}

                    <p className="dp-card-hint">
                        <Smartphone size={14} /> Daily Pilot روی اندروید، iOS، ویندوز و مک قابل نصب است.
                    </p>
                </div>
            </div>
        </div>
    )
}
