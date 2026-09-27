"use client"

import { useId, useState } from "react"
import { ChevronDown } from "lucide-react"
import { FAQ_ITEMS, setAllFaq, toggleFaqId } from "@/app/lib/faqContent"
import styles from "./faq.module.css"

/**
 * FaqAccordion — لیست پرسش‌های متداول.
 *
 * کامپوننت «نازک» است: هیچ قانونی ندارد. فهرست سؤال‌ها از
 * `app/lib/faqContent` می‌آید و منطقِ باز/بسته شدن همان‌جاست، پس چون این
 * پروژه jsdom ندارد، رفتار می‌تواند pure تست شود (همان الگوی
 * `createTaskForm` و `planProposalView`).
 *
 * دسترس‌پذیری:
 * - هر سؤال یک `<button>` واقعی است ⇒ Tab و Enter/Space بومی کار می‌کند.
 * - `aria-expanded` + `aria-controls` رابطهٔ سؤال و پاسخ را اعلام می‌کند.
 * - پنل پاسخ `role="region"` و لیبل‌شده با `aria-labelledby` است.
 * - حلقهٔ فوکوس واضح است (`:focus-visible` در CSS).
 * - آیکنِ چرخشی `aria-hidden` است تا صفحه‌خوان آن را نخواند؛ وضعیت واقعی
 *   از `aria-expanded` خوانده می‌شود.
 *
 * انیمیشن ارتفاع با `grid-template-rows: 0fr → 1fr` انجام می‌شود (همان تکنیک
 * پنل TaskCard) تا از تغییر `height` و پرش layout جلوگیری شود.
 */
export default function FaqAccordion() {
    const uid = useId()
    const [open, setOpen] = useState<string[]>([])

    const allOpen = open.length === FAQ_ITEMS.length

    return (
        <>
            <div className={styles.toolbar}>
                <button
                    type="button"
                    className={styles.toggleAll}
                    onClick={() => setOpen(setAllFaq(FAQ_ITEMS, !allOpen))}
                >
                    {allOpen ? "بستن همه" : "باز کردن همه"}
                </button>
            </div>

            <ul className={styles.list}>
                {FAQ_ITEMS.map((item) => {
                    const isOpen = open.includes(item.id)
                    const buttonId = `${uid}-q-${item.id}`
                    const panelId = `${uid}-a-${item.id}`

                    return (
                        <li key={item.id} className={styles.item}>
                            <h3 className={styles.questionHeading}>
                                <button
                                    type="button"
                                    id={buttonId}
                                    className={styles.question}
                                    aria-expanded={isOpen}
                                    aria-controls={panelId}
                                    onClick={() => setOpen((prev) => toggleFaqId(prev, item.id))}
                                >
                                    <span className={styles.questionText}>{item.question}</span>
                                    <span
                                        className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}
                                        aria-hidden="true"
                                    >
                                        <ChevronDown />
                                    </span>
                                </button>
                            </h3>

                            {/* پنل همیشه در DOM می‌ماند تا محتوا برای صفحه‌خوان و
                                جست‌وجوی مرورگر در دسترس باشد؛ فقط بسته می‌شود. */}
                            <div
                                id={panelId}
                                role="region"
                                aria-labelledby={buttonId}
                                aria-hidden={!isOpen}
                                className={`${styles.panel} ${isOpen ? styles.panelOpen : ""}`}
                            >
                                <div className={styles.panelInner}>
                                    <p className={styles.answer}>{item.answer}</p>
                                </div>
                            </div>
                        </li>
                    )
                })}
            </ul>
        </>
    )
}
