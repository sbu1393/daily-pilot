package ir.roozsaz.app.alarm;

import android.app.KeyguardManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import ir.roozsaz.app.R;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * صفحه‌ی تمام‌عرض آلارم: نام کار + زمان + «توقف» و «تعویق».
 *
 * <p>کاملاً نیتیو و مستقل از WebView است. روی صفحه‌ی قفل هم نمایش داده می‌شود و
 * صفحه را روشن می‌کند ({@code showWhenLocked}/{@code turnScreenOn} روی API 27+ و
 * فلگ‌های پنجره روی نسخه‌های قدیمی‌تر).
 *
 * <p>متن‌ها مستقیماً در چیدمان/کلاس آمده‌اند (نه از منبع ترجمه‌ی اپ) تا آلارم
 * حتی وقتی صفحه‌ی وب هرگز بارگذاری نشده باشد هم خوانا باشد.
 */
public class TaskAlarmActivity extends AppCompatActivity {

    private static final char[] PERSIAN_DIGITS = {'۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'};

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        showOverLockscreen();
        TaskAlarmController.ensureChannel(this);

        int alarmId = getIntent().getIntExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, -1);
        if (alarmId < 0) {
            finish();
            return;
        }

        TaskAlarmStore.Alarm alarm = TaskAlarmStore.get(this, alarmId);
        String title = alarm != null ? alarm.title : getIntent().getStringExtra(TaskAlarmReceiver.EXTRA_ALARM_TITLE);
        long at = alarm != null ? alarm.at : System.currentTimeMillis();

        setContentView(R.layout.activity_task_alarm);
        render(title, at);

        final int id = alarmId;

        Button stop = findViewById(R.id.alarm_stop);
        stop.setOnClickListener(view -> {
            TaskAlarmController.stop(this, id);
            finishAndRemoveTask();
        });

        Button snooze = findViewById(R.id.alarm_snooze);
        snooze.setOnClickListener(view -> {
            TaskAlarmController.snooze(this, id, TaskAlarmController.DEFAULT_SNOOZE_MINUTES);
            finishAndRemoveTask();
        });

        /*
         * اگر کاربر روی اعلان تپ کرده و صدا قبلاً خاموش شده بود (مثلاً بعد از
         * مهلت خودکار)، با باز شدن این صفحه دوباره شنیده می‌شود. اگر صدا در حال
         * پخش باشد، این فراخوانی بی‌اثر است.
         */
        TaskAlarmController.startRinger(this);
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        /* یک آلارم دیگر رسیده؛ همان صفحه با اطلاعات تازه بازسازی می‌شود. */
        recreate();
    }

    /** دکمه‌ی بازگشت = توقف (رفتاری قابل‌پیش‌بینی؛ آلارم در پس‌زمینه رها نمی‌شود). */
    @Override
    public void onBackPressed() {
        int alarmId = getIntent().getIntExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, -1);
        if (alarmId >= 0) TaskAlarmController.stop(this, alarmId);
        finishAndRemoveTask();
    }

    private void render(String title, long at) {
        TextView titleView = findViewById(R.id.alarm_title);
        titleView.setText(title == null || title.isEmpty() ? "آلارم کار" : title);

        TextView timeView = findViewById(R.id.alarm_time);
        timeView.setText("زمان: " + faDigits(new SimpleDateFormat("HH:mm", Locale.US).format(new Date(at))));
    }

    private void showOverLockscreen() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);

            KeyguardManager keyguard = getSystemService(KeyguardManager.class);
            if (keyguard != null) keyguard.requestDismissKeyguard(this, null);
            return;
        }

        getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
    }

    private static String faDigits(String value) {
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            out.append(c >= '0' && c <= '9' ? PERSIAN_DIGITS[c - '0'] : c);
        }
        return out.toString();
    }
}
