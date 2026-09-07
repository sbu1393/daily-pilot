"use client"

import { useEffect } from "react"
import { AnimatePresence, motion } from "framer-motion"
import styles from "@/app/components/task/task.module.css"

type Props = {
    open: boolean
    onClose: () => void
    children: React.ReactNode
}

/**
 * پوسته مودال انیمیشنی (framer-motion) — هم‌خانواده‌ی .overlay و .modal
 * در task.module.css تا ظاهر همه مودال‌ها یکسان بماند.
 */
export default function AnimatedModal({ open, onClose, children }: Props) {
    // بستن با Escape
    useEffect(() => {
        if (!open) return
        const h = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", h)
        return () => window.removeEventListener("keydown", h)
    }, [open, onClose])

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    className={styles.overlay}
                    onClick={onClose}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                >
                    <motion.div
                        className={styles.modal}
                        onClick={(e) => e.stopPropagation()}
                        initial={{ opacity: 0, scale: 0.94, y: 24 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.94, y: 24 }}
                        transition={{ type: "spring", stiffness: 380, damping: 30 }}
                    >
                        {children}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
