import Link from "next/link"
import Header from "@/app/components/Header"
import Hero from "@/app/components/landing/Hero"
import DashboardPreview from "@/app/components/landing/DashboardPreview"
import Features from "@/app/components/landing/Features"
import DownloadSection from "@/app/components/landing/DownloadSection"
import CTASection from "@/app/components/landing/CTASection"
import Footer from "@/app/components/layout/Footer"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import type { AvatarUser } from "@/app/components/Avatar"
import styles from "@/app/components/landing/landing.module.css"

// نشست کاربر فقط «یک بار» در سطح صفحه خوانده می‌شود و با Props به
// هدر و بخش‌های لندینگ منتقل می‌شود (الگوی Container + Composition).
// این‌طوری به‌جای دو کوئری، فقط یک کوئری دیتابیس در هر بازدید داریم.
async function getLandingUser(): Promise<AvatarUser | null> {
    try {
        return await getCurrentUser()
    } catch {
        return null
    }
}

export default async function Home() {
    const user = await getLandingUser()

    return (
        <main className={styles.landingPage}>
            <Header user={user} />
            {/*
              لینک موقت تست Android — فقط دسترسی سریع از داخل APK به /poc-native.
              موقتی است و پس از پایان تست PoC باید حذف شود.
            */}
            <div style={{ display: "flex", justifyContent: "center", padding: "0.5rem 1rem" }}>
                <Link
                    href="/poc-native"
                    style={{
                        fontSize: "0.85rem",
                        padding: "0.45rem 1rem",
                        borderRadius: 999,
                        border: "1px dashed #b26a00",
                        color: "#b26a00",
                        textDecoration: "none",
                    }}
                >
                    Android PoC
                </Link>
            </div>
            <Hero user={user} />
            <DashboardPreview />
            <Features />
            <DownloadSection />
            <CTASection user={user} />
            <Footer />
        </main>
    )
}
