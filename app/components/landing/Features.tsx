"use client"

import { motion } from "framer-motion"
import { CalendarDays, Target, TrendingUp, WifiOff, BellRing, Smartphone } from "lucide-react"
import styles from "./landing.module.css"

const features = [
    {
        icon: CalendarDays,
        title: "برنامه‌ریزی روزانه",
        text: "روز خودت رو با تقویم جلالی و برنامه‌های مشخص مدیریت کن.",
    },
    {
        icon: Target,
        title: "مدیریت Task با هوش مصنوعی",
        text: "کارها رو بساز؛ هوش مصنوعی خودش اولویت، امتیاز و زمان واقع‌بینانه انجام کارها رو پیشنهاد میده.",
    },
    {
        icon: TrendingUp,
        title: "رشد شخصی",
        text: "زمان سیو شده و پیشرفت خودت را هر روز ببین و بهتر عمل کن.",
    },
    {
        icon: WifiOff,
        title: "کارکرد آفلاین",
        text: "بدون اینترنت هم داشبوردت را ببین و کار بساز؛ بعداً خودکار سینک می‌شود.",
    },
    {
        icon: BellRing,
        title: "یادآور هوشمند",
        text:"سر وقت، برنامه روزانه‌ رو یادت می‌اندازیم.",
    },
    {
        icon: Smartphone,
        title: "نصب روی گوشی",
        text: "خیلی راحت میتونی روی موبایل نصب کنی .",
    },
]

export default function Features() {
    return (
        <section className={styles.features}>
            {features.map(({ icon: Icon, title, text }, i) => (
                <motion.div
                    key={title}
                    className={styles.featureCard}
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-60px" }}
                    transition={{ duration: .5, ease: [0.22, 1, 0.36, 1], delay: (i % 3) * 0.1 }}
                    whileHover={{ y: -6, transition: { duration: .2 } }}
                >
                    <div className={styles.featureIcon}>
                        <Icon size={26} strokeWidth={1.8} />
                    </div>
                    <h3 className={styles.featureTitle}>{title}</h3>
                    <p className={styles.featureText}>{text}</p>
                </motion.div>
            ))}
        </section>
    )
}
