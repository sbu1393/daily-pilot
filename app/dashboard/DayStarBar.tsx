"use client"

import { Clock, ListChecks, Timer, Sparkles, Pencil } from "lucide-react"
import { motion } from "framer-motion"
import { fmtMinutes } from "@/app/lib/time"
import type { DaySummary } from "../hooks/UseDaySummary"
import styles from "./dashboard.module.css"

/* ورود پله‌ای کارت‌های آمار */
const container = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.08 } },
}

const item = {
    hidden: { opacity: 0, y: 16 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } },
}

export default function DayStatsBar({
    summary,
    onEdit,
}: {
    summary: DaySummary
    onEdit: () => void
}) {
    const over = summary.overCommittedMinutes > 0
    const pct =
        summary.availableMinutes > 0
            ? Math.min(100, Math.round((summary.committedMinutes / summary.availableMinutes) * 100))
            : 0

    const cards = [
        {
            key: "budget",
            head: (
                <>
                    <Clock size={15} /> بودجه‌ی روز
                </>
            ),
            value: fmtMinutes(summary.availableMinutes),
        },
        {
            key: "committed",
            head: (
                <>
                    <ListChecks size={15} /> تخصیص‌شده
                </>
            ),
            value: fmtMinutes(summary.committedMinutes),
            progress: true,
        },
        {
            key: "pool",
            head: (
                <>
                    <Timer size={15} /> وقت آزاد
                </>
            ),
            value: fmtMinutes(summary.poolMinutes),
        },
        {
            key: "saved",
            head: (
                <>
                    <Sparkles size={15} /> سیو شده‌ی امروز
                </>
            ),
            value: fmtMinutes(summary.savedMinutes),
        },
    ]

    return (
        <>
            <motion.div
                className={styles.statsWrap}
                variants={container}
                initial="hidden"
                animate="visible"
            >
                {cards.map((c) => (
                    <motion.div
                        key={c.key}
                        className={`${styles.statCard} ${c.key === "pool" ? styles.pool : ""} ${
                            c.key === "saved" ? styles.saved : ""
                        }`}
                        variants={item}
                        whileHover={{ y: -4, transition: { duration: 0.2 } }}
                    >
                        <div className={styles.statHead}>{c.head}</div>
                        <div className={styles.statValue}>{c.value}</div>
                        {c.progress && (
                            <>
                                <div className={`${styles.progressTrack} ${over ? styles.over : ""}`}>
                                    <motion.div
                                        className={styles.progressFill}
                                        initial={{ width: 0 }}
                                        animate={{ width: `${over ? 100 : pct}%` }}
                                        transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
                                    />
                                </div>
                                {over && <div className={styles.warnChip}>بیش از بودجه</div>}
                            </>
                        )}
                    </motion.div>
                ))}
            </motion.div>

            <div className={styles.statsFooter}>
                <button className={styles.editBtn} onClick={onEdit}>
                    <Pencil size={14} /> تنظیم وقت روز
                </button>
            </div>
        </>
    )
}
