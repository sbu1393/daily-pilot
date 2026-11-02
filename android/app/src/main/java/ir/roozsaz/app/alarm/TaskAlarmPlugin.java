package ir.roozsaz.app.alarm;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.provider.Settings;

import java.lang.reflect.Method;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;

/**
 * پل جاوااسکریپت ↔ آلارم نیتیو تسک.
 *
 * <p>این پلاگین عمداً از {@code @capacitor/local-notifications} جدا است: آلارم
 * باید صدای واقعی و صفحه‌ی تمام‌عرض داشته باشد و مستقل از WebView/اینترنت/نشست
 * کار کند؛ در حالی که پلاگین یادآور فقط اعلان می‌سازد. تنها اشتراکشان «رعایت
 * ادب در قبال مجوزها» است.
 *
 * <p>همه‌ی متدها فقط وضعیت را گزارش می‌کنند و هیچ‌وقت ادعای موفقیتِ بی‌پشتوانه
 * نمی‌کنند: {@code schedule} صریحاً می‌گوید آلارم دقیق ثبت شد یا غیردقیق، و
 * قابلیت‌های سیستم (آلارم دقیق، تمام‌صفحه، اعلان) جداگانه قابل پرسیدن‌اند.
 */
@CapacitorPlugin(
        name = "TaskAlarm",
        permissions = {
                @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = TaskAlarmPlugin.NOTIFICATIONS)
        })
public class TaskAlarmPlugin extends Plugin {

    public static final String NOTIFICATIONS = "notifications";

    /* ------------------------------------------------------------------ */
    /* مجوز اختصاصی MIUI: «نمایش در قفل صفحه»                               */
    /* ------------------------------------------------------------------ */

    /** پکیج Security Center شیائومی (روی MIUI/HyperOS). */
    private static final String MIUI_SECURITY_CENTER = "com.miui.securitycenter";
    /** صفحه‌ی ویرایش مجوزهای ویژه‌ی یک اپ در Security Center (exported=true). */
    private static final String MIUI_PERMISSIONS_EDITOR =
            "com.miui.permcenter.permissions.PermissionsEditorActivity";
    /**
     * شماره‌ی op اختصاصی MIUI برای «نمایش در قفل صفحه». این یکی از appopهای
     * داخلی HyperOS است (نه permission استاندارد اندروید) و فقط عددی خوانده
     * می‌شود؛ روی گوشی‌های غیرشیائومی این op وجود ندارد یعنی «نامربوط».
     */
    private static final int MIUI_OP_SHOW_WHEN_LOCKED = 10020;

    /* AppOpsManager.MODE_ALLOWED / MODE_IGNORED — ثابت‌ها به‌صورت عددی تا به
     * فیلدهای فریم‌ورک وابسته نباشیم (روی ROMهای شیائومی مقدار یکسان است). */
    private static final int MODE_ALLOWED = 0;
    private static final int MODE_IGNORED = 2;

    /**
     * وضعیت op MIUI «نمایش در قفل صفحه»:
     *
     * <ul>
     *   <li>{@code granted} — اجازه دارد؛ صفحه‌ی آلارم روی قفل صفحه ظاهر می‌شود.</li>
     *   <li>{@code denied} — رد شده؛ صفحه‌ی آلارم موقع زنگ خوردن پشت قفل صفحه
     *       پنهان می‌ماند و کاربر چیزی نمی‌بیند.</li>
     *   <li>{@code unsupported} — نه شیائومی است و نه op قابل خواندن؛ در این حالت
     *       هیچ هشداری نباید به کاربر نشان داده شود.</li>
     * </ul>
     */
    private String lockScreenPermissionState() {
        if (!"xiaomi".equalsIgnoreCase(Build.MANUFACTURER)) return "unsupported";

        AppOpsManager ops =
                (AppOpsManager) getContext().getSystemService(Context.APP_OPS_SERVICE);
        if (ops == null) return "unsupported";

        try {
            /* API استاندارد `checkOpNoThrow(int, int, String)` روی همه‌ی ROMها
             * هست؛ فقط شماره‌ی op مالِ شیائومی است و نام ثابت ندارد ⇒ با عدد. */
            Method check =
                    AppOpsManager.class.getMethod(
                            "checkOpNoThrow", int.class, int.class, String.class);
            int mode =
                    (Integer) check.invoke(
                            ops,
                            MIUI_OP_SHOW_WHEN_LOCKED,
                            Process.myUid(),
                            getContext().getPackageName());
            return mode == MODE_ALLOWED ? "granted" : "denied";
        } catch (Exception e) {
            /* op روی این ROM وجود ندارد یا امضا عوض شده ⇒ به‌جای nag، سکوت. */
            return "unsupported";
        }
    }

    /**
     * باز کردن صفحه‌ی مجوزهای ویژه‌ی MIUI برای همین اپ — کاربر فقط سوییچ
     * «نمایش در قفل صفحه» را روشن می‌کند. مسیر پشتیبان: صفحه‌ی خود اپ در
     * تنظیمات (آن‌جا هم «سایر مجوزها» یک قدم فاصله دارد).
     */
    private boolean openLockScreenPermissionSettings() {
        if ("xiaomi".equalsIgnoreCase(Build.MANUFACTURER)) {
            try {
                Intent editor = new Intent();
                editor.setClassName(MIUI_SECURITY_CENTER, MIUI_PERMISSIONS_EDITOR);
                editor.putExtra("extra_pkgname", getContext().getPackageName());
                editor.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(editor);
                return true;
            } catch (Exception ignoredEditor) {
                /* نسخه‌های مختلف HyperOS می‌توانند اسم activity را عوض کنند؛
                 * به‌جای پیام خطای مبهم، مستقیم مسیر پشتیبان را می‌رویم. */
            }
        }

        return openSettings(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS));
    }

    /* ------------------------------------------------------------------ */
    /* قابلیت‌های سیستم                                                    */
    /* ------------------------------------------------------------------ */

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    private JSObject status() {
        JSObject object = new JSObject();
        object.put("available", true);
        object.put("exactAlarm", TaskAlarmScheduler.canScheduleExact(getContext()));
        object.put("fullScreenIntent", canUseFullScreenIntent());
        object.put("notifications", notificationsAllowed());
        object.put("lockScreenPermission", lockScreenPermissionState());
        object.put("sdk", Build.VERSION.SDK_INT);
        return object;
    }

    /**
     * روی Android 14+ نمایش اعلان به‌صورت تمام‌صفحه فقط با مجوز
     * USE_FULL_SCREEN_INTENT ممکن است و آن هم برای همه‌ی اپ‌ها پیش‌فرض داده
     * نمی‌شود. اگر «نه» باشد، آلارم هنوز صدا دارد و اعلان برجسته نشان داده
     * می‌شود؛ فقط صفحه‌ی تمام‌عرض باز نمی‌شود.
     */
    private boolean canUseFullScreenIntent() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true;

        NotificationManager manager =
                (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);

        return manager == null || manager.canUseFullScreenIntent();
    }

    private boolean notificationsAllowed() {
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return enabled && getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED;
        }

        return enabled;
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject object = new JSObject();
            object.put("granted", notificationsAllowed());
            call.resolve(object);
            return;
        }

        if (getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            JSObject object = new JSObject();
            object.put("granted", true);
            call.resolve(object);
            return;
        }

        requestPermissionForAlias(NOTIFICATIONS, call, "notificationsCallback");
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        JSObject object = new JSObject();
        object.put("granted", notificationsAllowed());
        call.resolve(object);
    }

    /** باز کردن صفحه‌ی «آلارم‌ها و یادآورها» — کاربر خودش اجازه را می‌دهد. */
    @PluginMethod
    public void requestExactAlarmPermission(PluginCall call) {
        JSObject object = new JSObject();
        object.put("granted", TaskAlarmScheduler.canScheduleExact(getContext()));

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || TaskAlarmScheduler.canScheduleExact(getContext())) {
            object.put("opened", false);
            call.resolve(object);
            return;
        }

        object.put("opened", openSettings(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)));
        call.resolve(object);
    }

    /**
     * باز کردن صفحه‌ی مجوز ویژه‌ی MIUI «نمایش در قفل صفحه».
     *
     * <p>نشستن روی این مجوز ناخواسته اتفاق می‌افتد: روی شیائومی پیش‌فرض «رد»
     * است و آلارم زنگ می‌زند ولی صفحه‌اش پشت قفل صفحه پنهان می‌ماند. هیچ API
     * عمومی برای اجازه‌دادن برنامه‌نویسی‌شده وجود ندارد؛ تنها راه درست، همان
     * صفحه‌ی خودِ Security Center است که همین‌جا برای اپ باز می‌شود و کاربر
     * فقط سوییچ را می‌زند. اگر لازم نباشد (اجازه داده، یا غیرشیائومی) هیچ
     * صفحه‌ای باز نمی‌شود.
     */
    @PluginMethod
    public void requestLockScreenPermission(PluginCall call) {
        String state = lockScreenPermissionState();

        JSObject object = new JSObject();
        object.put("state", state);
        object.put("granted", "granted".equals(state));

        if (!"denied".equals(state)) {
            object.put("opened", false);
            call.resolve(object);
            return;
        }

        object.put("opened", openLockScreenPermissionSettings());
        call.resolve(object);
    }

    @PluginMethod
    public void requestFullScreenIntentPermission(PluginCall call) {
        JSObject object = new JSObject();
        object.put("granted", canUseFullScreenIntent());

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE || canUseFullScreenIntent()) {
            object.put("opened", false);
            call.resolve(object);
            return;
        }

        object.put("opened", openSettings(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)));
        call.resolve(object);
    }

    /** باز کردن تنظیمات مخصوص همین اپ (بدون ادعای موفقیت؛ فقط «باز شد یا نه»). */
    private boolean openSettings(Intent intent) {
        try {
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* زمان‌بندی                                                            */
    /* ------------------------------------------------------------------ */

    @PluginMethod
    public void schedule(PluginCall call) {
        Integer id = call.getInt("id");
        Integer taskId = call.getInt("taskId");
        Long at = call.getLong("at");
        String title = call.getString("title", "");

        if (id == null || taskId == null || at == null) {
            call.reject("id، taskId و at الزامی‌اند");
            return;
        }

        long now = System.currentTimeMillis();

        if (at <= now) {
            call.reject("IN_THE_PAST", "زمان آلارم گذشته است");
            return;
        }

        TaskAlarmStore.Alarm alarm = new TaskAlarmStore.Alarm(id, taskId, title, at, now);
        boolean stored = TaskAlarmStore.put(getContext(), alarm);

        if (!stored) {
            android.util.Log.e("TaskAlarm", "PLUGIN_SCHEDULE_STORE_FAILED id=" + id);
            call.reject("STORE_FAILED", "نوشتن آلارم در ذخیره‌ساز شکست خورد");
            return;
        }

        /* گواهِ «فراخوانی JS به پلاگین رسید و Store نوشت» — قبل از ثبت روی
         * AlarmManager، تا مشخص شود شکست در کدام لایه رخ داده است. */
        android.util.Log.i("TaskAlarm", "PLUGIN_SCHEDULE id=" + id
                + " taskId=" + taskId
                + " at=" + at
                + " title=" + title
                + " stored=" + stored);

        boolean exact = TaskAlarmScheduler.schedule(getContext(), alarm);

        android.util.Log.i("TaskAlarm", "PLUGIN_SCHEDULE_DONE id=" + id + " exact=" + exact);

        JSObject object = status();
        object.put("id", id);
        object.put("at", at);
        /* صریح: آیا آلارم دقیق ثبت شد یا مسیر غیردقیق (setAndAllowWhileIdle) رفتیم. */
        object.put("exact", exact);
        call.resolve(object);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Integer id = call.getInt("id");

        if (id == null) {
            call.reject("id الزامی است");
            return;
        }

        android.util.Log.i("TaskAlarm", "CMD_CANCEL id=" + id
                + " " + TaskAlarmProcess.describe(getContext()));

        /*
         * Controller.stop مسیر مشترک است: رکورد را اتمیک حذف می‌کند، زمان‌بندی
         * را لغو می‌کند، اعلان را می‌بندد و اگر همین آلارم نشست فعال باشد به
         * پروسهٔ :alarm فرمان خاموش‌کردن صدا می‌فرستد.
         */
        boolean stopped = TaskAlarmController.stop(getContext(), id);

        if (!stopped) {
            call.reject("STOP_FAILED", "حذف آلارم از ذخیره‌ساز یا توقف نشست شکست خورد");
            return;
        }

        call.resolve();
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        TaskAlarmStore.Session session = TaskAlarmStore.session(getContext());
        int active = session == null ? -1 : session.alarmId;
        List<TaskAlarmStore.Alarm> alarms = TaskAlarmStore.all(getContext());

        android.util.Log.i("TaskAlarm", "CMD_CANCEL_ALL count=" + alarms.size()
                + " active=" + active
                + " " + TaskAlarmProcess.describe(getContext()));

        boolean activeWasListed = false;
        boolean allOk = true;

        for (TaskAlarmStore.Alarm alarm : alarms) {
            if (alarm.id == active) activeWasListed = true;
            allOk &= TaskAlarmController.stop(getContext(), alarm.id);
        }

        /*
         * اگر نشانگر فعال یتیم مانده و رکوردش در لیست نبود، همان را هم
         * خاموش می‌کنیم؛ وگرنه صدای بی‌رکورد رها می‌شد.
         */
        if (active >= 0 && !activeWasListed) {
            allOk &= TaskAlarmController.stop(getContext(), active);
        }

        if (!allOk) {
            call.reject("STOP_FAILED", "بخشی از آلارم‌ها حذف/متوقف نشدند");
            return;
        }

        call.resolve();
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSArray array = new JSArray();

        for (TaskAlarmStore.Alarm alarm : TaskAlarmStore.all(getContext())) {
            JSObject object = new JSObject();
            object.put("id", alarm.id);
            object.put("taskId", alarm.taskId);
            object.put("title", alarm.title);
            object.put("at", alarm.at);
            object.put("createdAt", alarm.createdAt);
            array.put(object);
        }

        JSObject result = new JSObject();
        result.put("alarms", array);
        result.put("exactAlarm", TaskAlarmScheduler.canScheduleExact(getContext()));
        call.resolve(result);
    }

    /* ------------------------------------------------------------------ */
    /* زنگ در جریان                                                        */
    /* ------------------------------------------------------------------ */

    @PluginMethod
    public void stop(PluginCall call) {
        Integer id = call.getInt("id");

        if (id == null) {
            call.reject("id الزامی است");
            return;
        }

        android.util.Log.i("TaskAlarm", "CMD_STOP_PLUGIN id=" + id
                + " " + TaskAlarmProcess.describe(getContext()));

        /*
         * «stop» از نظر کاربر یعنی همین حالا زنگ را قطع کن. اگر آلارم هنوز
         * زمان‌بندی‌شده باشد، لغو آن هم منطقی است؛ پس همان مسیر cancel را
         * می‌رویم تا رکورد و AlarmManager هم تمیز بمانند.
         */
        boolean stopped = TaskAlarmController.stop(getContext(), id);

        if (!stopped) {
            call.reject("STOP_FAILED", "توقف/حذف آلارم شکست خورد");
            return;
        }

        call.resolve();
    }

    @PluginMethod
    public void snooze(PluginCall call) {
        Integer id = call.getInt("id");
        Integer minutes = call.getInt("minutes", TaskAlarmController.DEFAULT_SNOOZE_MINUTES);

        if (id == null) {
            call.reject("id الزامی است");
            return;
        }

        int safeMinutes = minutes == null ? TaskAlarmController.DEFAULT_SNOOZE_MINUTES : minutes;

        android.util.Log.i("TaskAlarm", "CMD_SNOOZE_PLUGIN id=" + id
                + " minutes=" + safeMinutes
                + " " + TaskAlarmProcess.describe(getContext()));

        long at = TaskAlarmController.snooze(getContext(), id, safeMinutes);

        if (at < 0L) {
            call.reject("NOT_FOUND", "آلارم موردنظر در ذخیره‌ساز پیدا نشد");
            return;
        }

        JSObject object = status();
        object.put("at", at);
        call.resolve(object);
    }
}
