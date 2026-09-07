"use client"

import Link from "next/link"
import { motion } from "framer-motion"
import type { AvatarUser } from "@/app/components/Avatar"
import styles from "./landing.module.css"

const container = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.12 } },
}

const item = {
    hidden: { opacity: 0, y: 26 },
    visible: {
        opacity: 1,
        y: 0,
        transition: { duration: .6, ease: [0.22, 1, 0.36, 1] as const },
    },
}

// user را صفحه‌ی والد (app/page.tsx) یک بار می‌خواند و پاس می‌دهد؛
// اگر نشست معتبر باشد، به جای دکمه‌های ورود/ثبت‌نام، «ورود به برنامه» دیده می‌شود.
export default function Hero({ user }: { user: AvatarUser | null }) {
    return (
        <section className={styles.hero}>
            <motion.div
                className={styles.heroContent}
                variants={container}
                initial="hidden"
                animate="visible"
            >
                <motion.div variants={item} className={styles.heroLogo}>
                    D
                </motion.div>
                <motion.h1 variants={item}>
                    مدیریت روزهای خودت
                    <br />
                    با <span className={styles.brand}>Daily Pilot</span>
                </motion.h1>
                <motion.p variants={item}>
                    یک سیستم هوشمند برای برنامه‌ریزی، مدیریت کارها و ساختن عادت‌های بهتر.
                </motion.p>
                <motion.div variants={item} className={styles.heroActions}>
                    {user ? (
                        <Link href="/dashboard" className={styles.primaryBtn}>
                            ورود به برنامه
                        </Link>
                    ) : (
                        <>
                            <Link href="/auth/register" className={styles.primaryBtn}>شروع رایگان</Link>
                            <Link href="/auth/login" className={styles.secondaryBtn}>ورود به حساب</Link>
                        </>
                    )}
                </motion.div>
            </motion.div>
        </section>
    )
}
