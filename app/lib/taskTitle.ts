// طول مجاز عنوان تسک — **تنها منبع حقیقت**.
//
// این عدد نباید در schemaها/کامپوننتها تکرار شود؛ همه از همین ماژول می‌خوانند.
// پیام خطا هم از همان عدد ساخته می‌شود تا هرگز با هم ناهماهنگ نشوند.

import { faDigits } from "./time"

export const TASK_TITLE_MAX_LENGTH = 30

export const TASK_TITLE_TOO_LONG_MESSAGE =
    `عنوان تسک نمی‌تواند بیشتر از ${faDigits(TASK_TITLE_MAX_LENGTH)} کاراکتر باشد.`
