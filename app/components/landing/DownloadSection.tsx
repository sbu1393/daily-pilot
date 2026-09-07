"use client"

import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { motion } from "framer-motion"
import { Apple, MonitorSmartphone, QrCode, Smartphone } from "lucide-react"
import { useInstallPrompt } from "@/app/hooks/useInstallPrompt"
import styles from "./landing.module.css"

/**
 * بخش «نصب روی گوشی» در انتهای لندینگ:
 * کد QR آدرس سایت + دکمه‌ی نصب مستقیم برای اندروید/دسکتاپ (کروم/ادج)
 * و راهنمای Add to Home Screen برای آیفون (سافاری).
 */
export default function DownloadSection() {
    const { canInstall, promptInstall } = useInstallPrompt()
    const [qr, setQr] = useState<string | null>(null)
    const [ios, setIos] = useState(false)

    useEffect(() => {
        QRCode.toDataURL(window.location.origin, {
            width: 220,
            margin: 1,
            color: { dark: "#1e1b4b", light: "#ffffff" },
            errorCorrectionLevel: "M",
        })
            .then(setQr)
            .catch(() => setQr(null))
        setIos(/iphone|ipad|ipod/i.test(window.navigator.userAgent))
    }, [])

    const install = async () => {
        const ok = await promptInstall()
        if (ok) window.dispatchEvent(new Event("dp:synced"))
    }

    return (
        <section className={styles.downloadSection} id="download">
            <motion.div
                className={styles.downloadCard}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: .6, ease: [0.22, 1, 0.36, 1] }}
            >
                <h2 className={styles.downloadTitle}>
                    <Smartphone size={22} /> Daily Pilot را روی گوشی‌ات نصب کن
                </h2>
                <p className={styles.downloadText}>
                    با دوربین گوشی کد زیر را اسکن کن تا همین صفحه روی گوشی‌ات باز شود؛ بعد طبق راهنما
                    اپ را روی صفحه اصلی نصب کن — آیکون اختصاصی، اجرای تمام‌صفحه و کارکرد آفلاین.
                </p>

                <div className={styles.downloadGrid}>
                    <div className={styles.qrBox}>
                        {qr ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={qr} alt="کد QR نصب Daily Pilot" className={styles.qrImg} />
                        ) : (
                            <div className={styles.qrPlaceholder}>
                                <QrCode size={34} />
                                <span>در حال ساخت کد…</span>
                            </div>
                        )}
                        <span className={styles.qrCaption}>اسکن با دوربین گوشی</span>
                    </div>

                    <div className={styles.downloadActions}>
                        {canInstall && (
                            <button type="button" className={styles.primaryBtn} onClick={install}>
                                <MonitorSmartphone size={18} /> نصب مستقیم روی این دستگاه
                            </button>
                        )}

                        <div className={styles.platformCard}>
                            <strong><MonitorSmartphone size={16} /> اندروید و دسکتاپ (Chrome / Edge)</strong>
                            <ol>
                                <li>لینک را در کروم باز کن</li>
                                <li>منوی سه‌نقطه ← <b>Install app</b> / <b>Add to Home screen</b></li>
                            </ol>
                        </div>

                        <div className={styles.platformCard}>
                            <strong><Apple size={16} /> آیفون و آیپد (Safari)</strong>
                            <ol>
                                <li>این صفحه را در Safari باز کن</li>
                                <li>دکمه اشتراک <b>(Share)</b> ← <b>Add to Home Screen</b> ← <b>Add</b></li>
                            </ol>
                        </div>

                        {ios && (
                            <span className={styles.iosHint}>
                                📱 دستگاه تو آیفون است — مستقیم از راهنمای سافاری بالا برو
                            </span>
                        )}
                    </div>
                </div>
            </motion.div>
        </section>
    )
}
