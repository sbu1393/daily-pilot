package ir.roozsaz.app.alarm;

import android.app.Application;
import android.content.Context;
import android.os.Build;
import android.os.Process;
import android.util.Log;

import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

/**
 * شناسایی پروسه‌ای که کد در آن اجرا می‌شود.
 *
 * <p>روی API 28+ منبع اصلی {@link Application#getProcessName()} است که
 * سیستم‌عامل نگه می‌دارد و به فایل پروسه وابسته نیست. فقط روی نسخه‌های
 * قدیمی‌تر (یا اگر API مقدار معتبر برنگرداند) از {@code /proc/self/cmdline}
 * استفاده می‌شود. {@code Process.myPid()} تنها شناسهٔ عددی است و برای تشخیص
 * main از {@code :alarm} کافی نیست.
 *
 * <p>هیچ تصمیم مخربی بر پایهٔ این کلاس گرفته نمی‌شود؛ فقط لاگ و شاخه‌های
 * ایمنی (مثل «آیا همین حالا در پروسهٔ آلارم هستیم؟»). اگر نام خوانده نشود،
 * مقدار {@code "?"} برمی‌گردد و فراخواننده باید آن را «نامشخص» بداند.
 */
public final class TaskAlarmProcess {

    private static final String TAG = "TaskAlarm";

    private TaskAlarmProcess() {
    }

    /** نام واقعی پروسهٔ جاری، یا {@code "?"} اگر خواندن ممکن نباشد. */
    public static String name() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                String current = Application.getProcessName();
                if (current != null && !current.isEmpty()) return current;
            } catch (Exception e) {
                Log.w(TAG, "Application.getProcessName شکست خورد؛ /proc جایگزین می‌شود", e);
            }
        }

        FileInputStream in = null;
        try {
            in = new FileInputStream("/proc/self/cmdline");
            byte[] buffer = new byte[256];
            int count = in.read(buffer);
            if (count <= 0) return "?";

            int end = 0;
            while (end < count && buffer[end] != 0) end++;
            if (end == 0) return "?";

            return new String(buffer, 0, end, StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "خواندن نام پروسه شکست خورد", e);
            return "?";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    /* ignore */
                }
            }
        }
    }

    /** آیا همین حالا در پروسهٔ {@code ir.roozsaz.app:alarm} هستیم؟ */
    public static boolean isAlarmProcess(Context context) {
        String current = name();
        if (current == null || current.isEmpty() || "?".equals(current)) return false;

        return current.equals(context.getApplicationContext().getPackageName() + ":alarm");
    }

    /** متن کوتاه و یکتا برای لاگ‌های تشخیصی. */
    public static String describe(Context context) {
        String current = name();
        String packageName = context.getApplicationContext().getPackageName();

        String role;
        if (current.equals(packageName)) {
            role = "main";
        } else if (current.equals(packageName + ":alarm")) {
            role = "alarm";
        } else {
            role = "unknown";
        }

        return "process=" + current + " pid=" + Process.myPid() + " role=" + role;
    }
}
