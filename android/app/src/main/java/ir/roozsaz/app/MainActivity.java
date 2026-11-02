package ir.roozsaz.app;

import android.content.Context;
import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import ir.roozsaz.app.alarm.TaskAlarmController;
import ir.roozsaz.app.alarm.TaskAlarmPlugin;
import ir.roozsaz.app.alarm.TaskAlarmScheduler;
import ir.roozsaz.app.alarm.TaskAlarmStore;

public class MainActivity extends BridgeActivity {

    /** همان تگ کل زنجیره‌ی آلارم تا `adb logcat -s TaskAlarm` همه‌چیز را ببیند. */
    private static final String TAG = "TaskAlarm";

    /**
     * حداقل فاصلهٔ میان دو بازیابی.
     *
     * <p>چون هم `onCreate` و هم `onResume` این کار را می‌کنند، در یک راه‌اندازیِ
     * معمولی پشت‌سرهم صدا زده می‌شوند. بازیابی خودش idempotent است (اینجا فقط
     * هزینهٔ کم می‌شود، نه رفتار عوض).
     */
    private static final long RECOVERY_MIN_INTERVAL_MS = 2_000L;

    /**
     * تک‌رشته‌ای برای بازیابی آلارم‌ها.
     *
     * <p>چرا روی رشتهٔ جدا: {@link TaskAlarmStore} روی SQLite می‌نویسد و
     * فراخوانی‌های {@code AlarmManager} هم binder-call هستند. اجرای این‌ها روی
     * رشتهٔ اصلی می‌تواند در لحظهٔ راه‌اندازی باعث لرزشِ UI یا حتی ANR شود.
     */
    private static final ExecutorService ALARM_RECOVERY = Executors.newSingleThreadExecutor();

    private static long lastRecoveryAt = 0L;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /*
         * پلاگین آلارم تسک باید **قبل** از super.onCreate ثبت شود؛ Capacitor
         * فقط در همین بازه پلاگین‌های محلی را می‌شناسد. هیچ پلاگین دیگری تغییر
         * نکرده است.
         */
        registerPlugin(TaskAlarmPlugin.class);
        super.onCreate(savedInstanceState);

        requestAlarmRecovery("onCreate");
    }

    @Override
    public void onResume() {
        super.onResume();

        /*
         * چرا onResume هم هست، در کنار onCreate؟
         *
         * سناریویی که onCreate هرگز اجرا نمی‌شود: سیستم‌عامل (یا بهینه‌سازِ
         * سازنده) پروسه را زنده نگه داشته ولی آلارم‌های ثبت‌شده روی
         * AlarmManager را حذف کرده است. در این حالت هیچ ساختنِ دوباره‌ای رخ
         * نمی‌دهد و تنها نقطه‌ای که می‌توانیم ترمیم کنیم، بازگشتِ کاربر به اپ
         * است. اینجا هم از همان ذخیره‌سازِ persistent استفاده می‌شود.
         */
        requestAlarmRecovery("onResume");
    }

    /**
     * ثبت دوبارهٔ آلارم‌های آینده روی AlarmManager.
     *
     * <p><b>کاملاً نیتیو و مستقل:</b> به WebView، به JS، به سایتِ از راه‌دور و به
     * اینترنت هیچ وابستگی‌ای ندارد. منبع حقیقت، {@link TaskAlarmStore} (SQLite
     * با تراکنش، برای دسترسی امن از دو پروسه) است؛ همان چیزی که هنگام ثبتِ
     * اولیه هم نوشته شده بود.
     *
     * <p><b>چرا این لازم بود:</b> حذفِ اپ از Recent Apps روی برخی سیستم‌عامل‌ها
     * معادلِ force-stop است و آلارم‌های {@code AlarmManager} را از جدول سیستم
     * پاک می‌کند. چون هیچ‌کدام از رویدادهای بازیابیِ موجود
     * ({@code BOOT_COMPLETED}/{@code MY_PACKAGE_REPLACED}/{@code TIME_SET}/
     * {@code TIMEZONE_CHANGED}) با این حالت ربطی ندارند، آلارم برای همیشه
     * گم می‌شد. این فراخوانی همان شکاف را می‌پوشاند: اولین باز شدنِ اپ بعد از
     * هر حذفی، آلارم‌های آینده را دوباره ثبت می‌کند.
     */
    private void requestAlarmRecovery(final String source) {
        long now = System.currentTimeMillis();

        synchronized (MainActivity.class) {
            if (now - lastRecoveryAt < RECOVERY_MIN_INTERVAL_MS) return;
            lastRecoveryAt = now;
        }

        final Context app = getApplicationContext();

        ALARM_RECOVERY.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    /*
                     * اگر پروسهٔ :alarm بعد از زنگ مرده باشد، ممکن است نشانگر
                     * نشست فعال و اعلانش باقی مانده باشند. این پاک‌سازی فقط
                     * بعد از سقف زنگ + مهلت دست می‌زند تا زنگ سالم را نکشد.
                     */
                    TaskAlarmController.cleanupOrphanedRing(app);

                    int stored = TaskAlarmStore.all(app).size();
                    int restored = TaskAlarmScheduler.rescheduleUpcoming(app);

                    Log.i(TAG, "بازیابی آلارم‌ها [" + source + "]: "
                            + stored + " رکورد در ذخیره‌ساز، "
                            + restored + " آلارم آینده دوباره روی AlarmManager ثبت شد");
                } catch (Exception e) {
                    Log.w(TAG, "بازیابی آلارم‌ها شکست خورد [" + source + "]", e);
                }
            }
        });
    }
}
