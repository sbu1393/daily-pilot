"use client"

import Link from "next/link"
import { motion } from "framer-motion"
import type { AvatarUser } from "@/app/components/Avatar"
import styles from "./landing.module.css"

// مثل Hero: نشست معتبر یعنی به جای «ساخت حساب»، کاربر مستقیم وارد برنامه می‌شود.
export default function CTASection({ user }: { user: AvatarUser | null }) {
    return (
        <section className={styles.ctaSection}>
            <motion.div
                className={styles.ctaCard}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: .6, ease: [0.22, 1, 0.36, 1] }}
            >
                <h2 className={styles.ctaTitle}>آماده‌ای روزهای بهتری بسازی؟</h2>
                <p className={styles.ctaText}>همین الان حساب خودت را بساز و شروع کن.</p>
                <Link
                    href={user ? "/dashboard" : "/auth/register"}
                    className={styles.primaryBtn}
                >
                    {user ? "ورود به برنامه" : "ساخت حساب رایگان"}
                </Link>
            </motion.div>
        </section>
    )
}
