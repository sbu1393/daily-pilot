package ir.roozsaz.app.alarm;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * ذخیره‌ی محلی آلارم‌های تسک — منبع حقیقتِ زمان‌بندی روی دستگاه.
 *
 * <p>چرا SharedPreferences و نه localStorage؟
 * آلارم باید بدون WebView، بدون اینترنت و بدون نشستِ ورود کار کند. پس منبع
 * حقیقتِ زمان‌بندی باید در خودِ اندروید باشد؛ localStorage فقط برای نمایش UI
 * آینه می‌شود. {@link TaskAlarmBootReceiver} هم بعد از ری‌استارت از همین‌جا
 * بازیابی می‌کند، پس اطلاعات در WebView گم نمی‌شود.
 *
 * <p>نوشتن با {@code commit()} انجام می‌شود (نه {@code apply()}) چون گیرنده‌ی
 * آلارم ممکن است بلافاصله بعد از ثبت پروسه را از دست بدهد و به تعهدِ نوشتن
 * نیاز داریم.
 */
public final class TaskAlarmStore {

    private static final String TAG = "TaskAlarm";

    private static final String PREFS_NAME = "dp_task_alarms";
    private static final String KEY_LIST = "alarms_v1";

    private TaskAlarmStore() {
    }

    /** یک آلارمِ تسک. */
    public static final class Alarm {
        /** شناسه‌ی قطعی آلارم (از شناسه‌ی تسک ساخته می‌شود و پایدار است). */
        public final int id;
        public final int taskId;
        public final String title;
        /** لحظه‌ی زنگ (epoch ms). */
        public final long at;
        public final long createdAt;

        public Alarm(int id, int taskId, String title, long at, long createdAt) {
            this.id = id;
            this.taskId = taskId;
            this.title = title == null ? "" : title;
            this.at = at;
            this.createdAt = createdAt;
        }

        public JSONObject toJson() throws JSONException {
            JSONObject object = new JSONObject();
            object.put("id", id);
            object.put("taskId", taskId);
            object.put("title", title);
            object.put("at", at);
            object.put("createdAt", createdAt);
            return object;
        }

        /** داده‌ی ناقص/خراب ⇒ null (هیچ‌وقت استثنا به بیرون پرت نمی‌شود). */
        public static Alarm fromJson(JSONObject object) {
            if (object == null) return null;

            int id = object.optInt("id", -1);
            int taskId = object.optInt("taskId", -1);
            long at = object.optLong("at", -1L);

            if (id < 0 || taskId < 0 || at <= 0) return null;

            return new Alarm(id, taskId, object.optString("title", ""), at, object.optLong("createdAt", 0L));
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** همه‌ی آلارم‌های ذخیره‌شده، مرتب بر اساس زمان زنگ (صعودی). */
    public static List<Alarm> all(Context context) {
        List<Alarm> alarms = new ArrayList<>();

        try {
            String raw = prefs(context).getString(KEY_LIST, null);
            if (raw == null || raw.isEmpty()) return alarms;

            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                Alarm alarm = Alarm.fromJson(array.optJSONObject(i));
                if (alarm != null) alarms.add(alarm);
            }
        } catch (Exception e) {
            /* داده‌ی خراب نباید اپ را از پا دربیاورد؛ لیست خالی برگردانده می‌شود. */
            Log.w(TAG, "خواندن لیست آلارم‌ها شکست خورد", e);
            return new ArrayList<>();
        }

        Collections.sort(alarms, new Comparator<Alarm>() {
            @Override
            public int compare(Alarm a, Alarm b) {
                return Long.compare(a.at, b.at);
            }
        });

        return alarms;
    }

    public static Alarm get(Context context, int id) {
        for (Alarm alarm : all(context)) {
            if (alarm.id == id) return alarm;
        }
        return null;
    }

    private static void write(Context context, List<Alarm> alarms) {
        JSONArray array = new JSONArray();
        for (Alarm alarm : alarms) {
            try {
                array.put(alarm.toJson());
            } catch (JSONException e) {
                Log.w(TAG, "سریال‌سازی آلارم شکست خورد", e);
            }
        }

        SharedPreferences.Editor editor = prefs(context).edit().putString(KEY_LIST, array.toString());

        /* commit چون تعهدِ نوشتن پیش از پایان کار گیرنده لازم است. */
        if (!editor.commit()) {
            Log.w(TAG, "نوشتن لیست آلارم‌ها ناموفق بود");
        }
    }

    /** ثبت/جایگزینی آلارم یک تسک (هر تسک حداکثر یک آلارم فعال دارد). */
    public static void put(Context context, Alarm alarm) {
        List<Alarm> alarms = all(context);

        for (int i = 0; i < alarms.size(); i++) {
            if (alarms.get(i).id == alarm.id) {
                alarms.set(i, alarm);
                write(context, alarms);
                return;
            }
        }

        alarms.add(alarm);
        write(context, alarms);
    }

    public static void delete(Context context, int id) {
        List<Alarm> alarms = all(context);
        List<Alarm> next = new ArrayList<>();

        for (Alarm alarm : alarms) {
            if (alarm.id != id) next.add(alarm);
        }

        if (next.size() != alarms.size()) write(context, next);
    }

    /** آلارم‌های زمان‌گذشته پاک می‌شوند (نگه‌داشتنشان بی‌فایده است و لیست را رشد می‌دهد). */
    public static void prune(Context context, long now) {
        List<Alarm> alarms = all(context);
        List<Alarm> next = new ArrayList<>();

        for (Alarm alarm : alarms) {
            if (alarm.at > now) next.add(alarm);
        }

        if (next.size() != alarms.size()) write(context, next);
    }
}
