"use client"

import { useEffect, useState } from "react"
import { faDigits } from "@/app/lib/time"
import { type TaskItem } from "./taskTypes"
import AnimatedModal from "../motion/AnimatedModal"
import styles from "./task.module.css"

type Props = {
    tasks: TaskItem[]
    onClose: () => void
    onConfirm: (ids: number[]) => void
    busy: boolean
}

export default function RolloverDialog({ tasks, onClose, onConfirm, busy }: Props) {
    const [selected, setSelected] = useState<Set<number>>(() => new Set(tasks.map((t) => t.id)))

    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", h)
        return () => window.removeEventListener("keydown", h)
    }, [onClose])

    useEffect(() => {
        setSelected(new Set(tasks.map((t) => t.id)));
    }, [tasks]);


    const toggle = (id: number) => {
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    return (
        <AnimatedModal open onClose={onClose}>
                <div className={styles.modalHead}>
                    <h4>انتقال کارهای باقی‌مانده</h4>
                    <button className={styles.closeBtn} onClick={onClose}>✕</button>
                </div>
                <p className={styles.hint}>
                    {faDigits(tasks.length)} کار از روزهای قبل ناتمام مانده. کدام‌ها را به امروز منتقل کنم؟
                </p>
                <div className={styles.checkList}>
                    {tasks.length === 0 && (
                        <p className={styles.hint} style={{ margin: 0 }}>هیچ تسکی برای انتقال وجود ندارد.</p>
                    )}
                    {tasks.map((t) => (
                        <label key={t.id} className={styles.checkRow}>
                            <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                            <span className={styles.checkText}>{t.text}</span>
                            <span className={styles.checkMeta}>{faDigits(t.dayKey.replaceAll("-", "/"))}</span>
                        </label>
                    ))}
                </div>
                <div className={styles.modalActions}>
                    <button
                        className={styles.btnPrimary}
                        disabled={selected.size === 0 || busy}
                        onClick={() => onConfirm([...selected])}
                    >
                        {busy ? "در حال انتقال…" : `انتقال به امروز (${faDigits(selected.size)})`}
                    </button>
                    <button className={styles.btnGhost} onClick={onClose}>
                        بعداً
                    </button>
                </div>
        </AnimatedModal>
    )
}
