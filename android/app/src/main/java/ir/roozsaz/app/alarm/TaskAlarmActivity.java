package ir.roozsaz.app.alarm;

import android.app.KeyguardManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
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

    private static final String TAG = "TaskAlarm";

    private static final char[] PERSIAN_DIGITS = {'۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'};

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        showOverLockscreen();
        TaskAlarmController.ensureChannel(this);

        int alarmId = getIntent().getIntExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, -1);
        final String sessionToken = getIntent().getStringExtra(TaskAlarmReceiver.EXTRA_SESSION_TOKEN);
        Log.i(TAG, "ACTIVITY_CREATED alarmId=" + alarmId
                + " token=" + shortToken(sessionToken)
                + " " + TaskAlarmProcess.describe(this));

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
            TaskAlarmController.stop(this, id, sessionToken);
            finishAndRemoveTask();
        });

        Button snooze = findViewById(R.id.alarm_snooze);
        snooze.setOnClickListener(view -> {
            TaskAlarmController.snooze(this, id, TaskAlarmController.DEFAULT_SNOOZE_MINUTES, sessionToken);
            finishAndRemoveTask();
        });

        /*
         * عمداً هیچ startRinger اینجا نیست. باز شدن این صفحه — از اعلان، از
         * صفحهٔ قفل، یا به هر دلیل دیگری — نباید صدا را شروع کند. مالک صدا
         * فقط مسیر FIRE است؛ این Activity فقط نمایش و دکمه‌های توقف/تعویق است.
         */
        Log.i(TAG, "ACTIVITY_READY alarmId=" + alarmId
                + " ringing=" + TaskAlarmController.isRinging()
                + " " + TaskAlarmProcess.describe(this));
    }

    @Override
    protected void onStart() {
        super.onStart();
        Log.i(TAG, "ACTIVITY_STARTED alarmId=" + getIntent().getIntExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, -1));
    }

    @Override
    protected void onResume() {
        super.onResume();
        Log.i(TAG, "ACTIVITY_RESUMED alarmId=" + getIntent().getIntExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, -1));
    }

    @Override
    protected void onDestroy() {
        Log.i(TAG, "ACTIVITY_DESTROYED alarmId=" + getIntent().getIntExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, -1)
                + " isFinishing=" + isFinishing());
        super.onDestroy();
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
        String token = getIntent().getStringExtra(TaskAlarmReceiver.EXTRA_SESSION_TOKEN);
        if (alarmId >= 0) TaskAlarmController.stop(this, alarmId, token);
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

    private static String shortToken(String token) {
        if (token == null) return "null";
        return token.length() <= 8 ? token : token.substring(0, 8);
    }
}
