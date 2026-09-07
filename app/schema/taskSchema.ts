import { z } from "zod";


export const taskSchema = z.object({

    text:z
    .string()
    .min(3,"عنوان کوتاه است"),


    category:z
    .string()
    .min(1, "حتما باید دسته‌بندی انتخاب شود"),


    scheduledDate:z
    .string()


});