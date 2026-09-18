import { faDigits } from "@/app/lib/time"
import type { DayMarker } from "@/app/hooks/useHistoryMarkers"
import type { JalaliGridCell } from "./jalaliDate"
import styles from "./jalaliCalendar.module.css"

const WEEKDAYS = [
    "شنبه",
    "یکشنبه",
    "دوشنبه",
    "سه‌شنبه",
    "چهارشنبه",
    "پنجشنبه",
    "جمعه",
]

type JalaliMonthGridProps = {
    cells: JalaliGridCell[]
    markers: Record<string, DayMarker>
    onSelect: (canonicalKey: string) => void
}

export default function JalaliMonthGrid({ cells, markers, onSelect }: JalaliMonthGridProps) {
    return (
        <div className={styles.monthGrid} role="grid" aria-label="تقویم ماهانه">
            <div className={styles.weekdays} role="row">
                {WEEKDAYS.map((weekday) => (
                    <span key={weekday} role="columnheader" className={styles.weekday}>
                        {weekday}
                    </span>
                ))}
            </div>
            <div className={styles.gridCells}>
                {cells.map((cell) => {
                    const marker = markers[cell.canonicalKey]
                    const className = [
                        styles.gridDay,
                        cell.isCurrentMonth ? "" : styles.outsideMonth,
                        cell.isToday ? styles.today : "",
                        cell.isSelected ? styles.selected : "",
                    ].filter(Boolean).join(" ")

                    return (
                        <button
                            key={cell.canonicalKey}
                            type="button"
                            role="gridcell"
                            className={className}
                            disabled={!cell.isCurrentMonth}
                            aria-label={`${faDigits(cell.year)}/${faDigits(String(cell.month).padStart(2, "0"))}/${faDigits(String(cell.day).padStart(2, "0"))}`}
                            aria-current={cell.isToday ? "date" : undefined}
                            aria-selected={cell.isSelected}
                            onClick={() => onSelect(cell.canonicalKey)}
                        >
                            <span className={styles.gridDayNumber}>{faDigits(cell.day)}</span>
                            {marker && marker.doneCount > 0 && (
                                <span className={styles.gridMarker} aria-label={`${faDigits(marker.doneCount)} کار انجام شده`}>
                                    {marker.doneCount > 9 ? "۹+" : faDigits(marker.doneCount)}
                                </span>
                            )}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}
