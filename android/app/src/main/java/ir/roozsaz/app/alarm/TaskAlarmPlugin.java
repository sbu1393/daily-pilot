package ir.roozsaz.app.alarm;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

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
        TaskAlarmStore.put(getContext(), alarm);

        boolean exact = TaskAlarmScheduler.schedule(getContext(), alarm);

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

        TaskAlarmScheduler.cancel(getContext(), id);
        TaskAlarmController.stop(getContext(), id);
        call.resolve();
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        List<TaskAlarmStore.Alarm> alarms = TaskAlarmStore.all(getContext());

        for (TaskAlarmStore.Alarm alarm : alarms) {
            TaskAlarmScheduler.cancel(getContext(), alarm.id);
            TaskAlarmController.stop(getContext(), alarm.id);
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

        TaskAlarmController.stop(getContext(), id);
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

        long at = TaskAlarmController.snooze(getContext(), id, minutes == null ? TaskAlarmController.DEFAULT_SNOOZE_MINUTES : minutes);

        JSObject object = status();
        object.put("at", at);
        call.resolve(object);
    }
}
