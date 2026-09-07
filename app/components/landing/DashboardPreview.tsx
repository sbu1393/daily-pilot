import { motion } from "framer-motion"
import styles from "./landing.module.css"

const tasks = [
    { label: "مطالعه کتاب", done: true },
    { label: "تمرین زبان", done: false },
    { label: "آماده کردن گزارش", done: false },
]

export default function DashboardPreview() {
    return (
        <section className={styles.previewSection} aria-label="پیش‌نمایش داشبورد">
            <motion.div
                className={styles.previewCard}
                initial={{ opacity: 0, y: 30, scale: .98 }}
                whileInView={{ opacity: 1, y: 0, scale: 1 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: .55, ease: [0.22, 1, 0.36, 1] }}
            >
                <div className={styles.previewBar}>
                    <span className={styles.previewDots} aria-hidden="true">
                        <i /><i /><i />
                    </span>
                    <span className={styles.previewUrl}>app.dailypilot.ir</span>
                </div>
                <div className={styles.previewBody}>
                    <div className={styles.previewHeader}>
                        <h3>برنامه امروز</h3>
                        <span className={styles.previewBadge}>۳ کار</span>
                    </div>
                    <ul className={styles.taskList}>
                        {tasks.map((t, i) => (
                            <motion.li
                                key={t.label}
                                className={`${styles.task} ${t.done ? styles.taskDone : ""}`}
                                initial={{ opacity: 0, y: 14 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true, margin: "-40px" }}
                                transition={{ duration: .4, delay: i * .08 }}
                                whileHover={{ scale: 1.02, backgroundColor: "rgba(79, 70, 229, .08)" }}
                            >
                                <span className={styles.taskCheck} aria-hidden="true">{t.done ? "✓" : ""}</span>
                                <span className={styles.taskLabel}>{t.label}</span>
                            </motion.li>
                        ))}
                    </ul>
                </div>
            </motion.div>
        </section>
    )
}
