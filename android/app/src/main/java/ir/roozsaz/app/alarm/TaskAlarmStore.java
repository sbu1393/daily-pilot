package ir.roozsaz.app.alarm;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * ذخیره‌ی محلی آلارم‌های تسک — منبع حقیقتِ زمان‌بندی روی دستگاه.
 *
 * <p><b>چرا SQLite و نه SharedPreferences؟</b> پس از انتقال گیرنده/سرویس/صفحه
 * آلارم به پروسهٔ {@code :alarm}، دو پروسه هم‌زمان به این داده دست می‌زنند.
 * مدل قبلی «خواندن کل آرایه، تغییر، نوشتن کل آرایه» در چند پروسه می‌تواند
 * نوشتن یکی را روی دیگری بیندازد. SQLite با تراکنش و قفل فایل، این مشکل را
 * حل می‌کند؛ نوشتن‌ها کوچک‌اند و فرکانس پایین، بنابراین هزینه‌اش قابل قبول است.
 *
 * <p><b>مهاجرت:</b> کلید قدیمی {@code alarms_v1} در SharedPreferences دست‌نخورده
 * می‌ماند. در اولین باز شدن پایگاه‌داده، رکوردهای معتبر با
 * {@code INSERT OR IGNORE} وارد جدول می‌شوند تا نه داده‌ی تکراری ساخته شود و نه
 * رکورد موجود در SQLite (مثلاً نوشته‌شده توسط نسخه‌ی جدیدتر) از بین برود. یک
 * نشانگر در جدول {@code meta} از مهاجرت تکراری جلوگیری می‌کند. اگر لازم شد به
 * نسخه‌ی قبلی برگردیم، همان SharedPreferences قدیمی به‌عنوان عکس لحظه‌ی مهاجرت
 * در دسترس است؛ رکوردهای نوشته‌شده بعد از مهاجرت طبیعتاً در آن نیستند.
 *
 * <p>نوشتن‌ها با تراکنش انجام می‌شوند، اما WAL را عمداً روشن نمی‌کنیم: حجم
 * تراکنش‌ها بسیار کم است و حالت پیش‌فرضِ ژورنال به‌همراه retry برای قفل‌های
 * کوتاه چندپروسه‌ای کافی است. اگر در آزمون واقعی خطای busy تکرار شد، می‌توان
 * WAL را جداگانه بررسی کرد؛ تغییر آن اکنون بدون شاهد لازم نیست.
 */
public final class TaskAlarmStore {

    private static final String TAG = "TaskAlarm";

    private static final String DB_NAME = "dp_task_alarms.db";
    private static final int DB_VERSION = 1;

    private static final String PREFS_NAME = "dp_task_alarms";
    private static final String KEY_LIST = "alarms_v1";

    private static final String TABLE_ALARMS = "alarms";
    private static final String TABLE_META = "meta";

    private static final String META_MIGRATED_FROM_PREFS = "migrated_from_prefs";
    private static final String META_ACTIVE_ALARM_ID = "active_alarm_id";
    private static final String META_ACTIVE_SINCE = "active_since";
    private static final String META_ACTIVE_SINCE_ELAPSED = "active_since_elapsed";
    private static final String META_ACTIVE_ALARM_AT = "active_alarm_at";
    private static final String META_ACTIVE_SESSION_TOKEN = "active_session_token";

    /*
     * سقف انتظار عمداً کوتاه است: این کد از onReceive گیرندهٔ آلارم هم صدا
     * زده می‌شود و نباید رشتهٔ اصلی را به مرز ANR ببرد. قفل‌های واقعی این
     * پایگاه‌داده میلی‌ثانیه‌ای‌اند؛ اگر باز هم busy شد، false/خالی برگرداندن
     * بهتر از بلاک‌کردن زنگ است.
     */
    private static final int MAX_ATTEMPTS = 3;
    private static final long RETRY_DELAY_MS = 30L;

    private static volatile Helper helper;

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

    /**
     * یک نشستِ واقعی زنگ. {@code token} تنها در همان نشست معتبر است؛ هر فرمانی
     * که توکن دیگری داشته باشد نباید صدا، اعلان، نشانگر فعال، رکورد یا
     * زمان‌بندی نشست جاری را تغییر دهد.
     */
    public static final class Session {
        public final int alarmId;
        public final String token;
        /** زمان دیواری شروع (epoch ms) — فقط برای گزارش/سازگاری. */
        public final long since;
        /** زمان monotonic شروع — مرجع محاسبهٔ سن نشست. */
        public final long sinceElapsed;
        /** زمان رکوردی که این نشست بر اساس آن شروع شده است. */
        public final long at;

        public Session(int alarmId, String token, long since, long sinceElapsed, long at) {
            this.alarmId = alarmId;
            this.token = token == null ? "" : token;
            this.since = since;
            this.sinceElapsed = sinceElapsed;
            this.at = at;
        }

        public boolean matches(int expectedAlarmId, String expectedToken) {
            if (expectedAlarmId != alarmId) return false;
            return expectedToken == null || expectedToken.equals(token);
        }
    }

    /** نتیجهٔ یک تغییر اتمیک روی نشست فعال. */
    public enum EndStatus {
        /** نشست مورد انتظار پیدا و تغییر داده شد. */
        ENDED,
        /** نشست فعالی وجود نداشت؛ هیچ رکوردی هم حذف نشد. */
        NO_SESSION,
        /** توکن/شناسه با نشست فعال نمی‌خواند؛ هیچ تغییری انجام نشد. */
        STALE,
        /** خطای پایگاه‌داده؛ هیچ تغییری قابل‌اتکا نیست. */
        FAILED
    }

    public static final class EndResult {
        public final EndStatus status;
        public final boolean recordDeleted;
        /**
         * توکن نشستی که واقعاً پایان یافت (فقط برای {@link EndStatus#ENDED}).
         * برای فرستادن فرمان SILENCE با همان توکن لازم است، حتی وقتی
         * فراخواننده توکن را در snapshot قبلی خود نداشته است.
         */
        public final String token;

        EndResult(EndStatus status, boolean recordDeleted, String token) {
            this.status = status;
            this.recordDeleted = recordDeleted;
            this.token = token;
        }

        static EndResult failed() {
            return new EndResult(EndStatus.FAILED, false, null);
        }

        public boolean ok() {
            return status != EndStatus.FAILED;
        }
    }

    /** نتیجهٔ شروع نشست جدید (و پاک‌سازی اتمیک نشست قبلی). */
    public static final class StartResult {
        public final boolean ok;
        /**
         * رکوردِ همین آلارم (با همان {@code id + at}) داخل تراکنش پیدا نشد؛
         * احتمالاً همان لحظه cancel/Snooze شده است. نشست جدید ثبت نشده و
         * هیچ‌چیزِ نشست قبلی هم تغییر نکرده است.
         */
        public final boolean aborted;
        public final Session previous;
        public final boolean previousRecordDeleted;

        StartResult(boolean ok, boolean aborted, Session previous, boolean previousRecordDeleted) {
            this.ok = ok;
            this.aborted = aborted;
            this.previous = previous;
            this.previousRecordDeleted = previousRecordDeleted;
        }

        static StartResult failed() {
            return new StartResult(false, false, null, false);
        }

        static StartResult aborted(Session previous) {
            return new StartResult(false, true, previous, false);
        }
    }

    /** نتیجهٔ تعویق اتمیک (جایگزینی رکورد + پاک‌کردن نشست). */
    public static final class SnoozeResult {
        public final EndStatus status;
        public final boolean recordWritten;

        SnoozeResult(EndStatus status, boolean recordWritten) {
            this.status = status;
            this.recordWritten = recordWritten;
        }

        static SnoozeResult failed() {
            return new SnoozeResult(EndStatus.FAILED, false);
        }

        public boolean ok() {
            return status == EndStatus.ENDED || status == EndStatus.NO_SESSION;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static SQLiteOpenHelper helper(Context context) {
        Helper current = helper;
        if (current == null) {
            synchronized (TaskAlarmStore.class) {
                current = helper;
                if (current == null) {
                    current = new Helper(context.getApplicationContext());
                    helper = current;
                }
            }
        }
        return current;
    }

    private static SQLiteDatabase database(Context context) {
        SQLiteDatabase db = helper(context).getWritableDatabase();

        /*
         * دو پروسه ممکن است هم‌زمان بنویسند. busy_timeout باعث می‌شود SQLite
         * به‌جای پرت‌کردن فوری خطا، چند ثانیه صبر کند؛ retry لایهٔ بالاتر هم
         * برای قفل‌های طولانی‌تر (مهاجرت/باز شدن اولیه) هست.
         *
         * این PRAGMA یک ردیف نتیجه برمی‌گرداند، پس execSQL برایش مجاز نیست
         * (روی Android 13 با «Queries can be performed using ... only»
         * شکست می‌خورد و کل باز شدن Store را می‌کشد). با rawQuery اجرا و
         * Cursor بلافاصله بسته می‌شود. شکست این تنظیم هم نباید مانع ادامهٔ
         * کار شود؛ مقدار پیش‌فرض پلتفرم و retry موجود همچنان پابرجاست.
         */
        applyBusyTimeout(db);

        migrateFromPrefsIfNeeded(context, db);
        return db;
    }

    /**
     * تنظیم busy_timeout روی اتصال جاری. هر بار که {@link #database} صدا زده
     * می‌شود اجرا می‌شود (یعنی برای هر عملیات Store)، و Cursor با
     * try-with-resources بسته می‌شود. خطا فقط لاگ می‌شود تا باز شدن Store
     * هرگز به‌خاطر این تنظیم شکست نخورد.
     */
    private static void applyBusyTimeout(SQLiteDatabase db) {
        try (Cursor cursor = db.rawQuery("PRAGMA busy_timeout = 1500", null)) {
            /* یک step کافی است تا مقدار جدید اعمال شود. */
            cursor.moveToFirst();
        } catch (Exception e) {
            Log.w(TAG, "تنظیم busy_timeout شکست خورد؛ ادامه با مقدار پیش‌فرض", e);
        }
    }

    private static void migrateFromPrefsIfNeeded(Context context, SQLiteDatabase db) {
        if (hasMeta(db, META_MIGRATED_FROM_PREFS)) return;

        String raw;
        try {
            raw = prefs(context).getString(KEY_LIST, null);
        } catch (Exception e) {
            /*
             * «شکست خواندن» با «خالی بودن» یکی نیست. اگر نشانگر را در این
             * حالت بگذاریم، داده‌ی قدیمی برای همیشه مهاجرت‌نشده ولی
             * «مهاجرت‌شده» علامت می‌خورد. پس این بار صرف‌نظر می‌کنیم و در
             * دسترسی بعدی دوباره تلاش می‌شود.
             */
            Log.w(TAG, "خواندن SharedPreferences قدیمی شکست خورد؛ مهاجرت به بعد موکول شد", e);
            return;
        }

        List<Alarm> old = new ArrayList<>();
        boolean corrupt = false;

        if (raw != null && !raw.trim().isEmpty()) {
            try {
                JSONArray array = new JSONArray(raw);
                for (int i = 0; i < array.length(); i++) {
                    Alarm alarm = Alarm.fromJson(array.optJSONObject(i));
                    if (alarm != null) old.add(alarm);
                }
            } catch (JSONException e) {
                corrupt = true;
                Log.w(TAG, "داده‌ی قدیمی آلارم‌ها قابل خواندن نبود؛ مهاجرت خالی ثبت می‌شود", e);
            }
        }

        db.beginTransaction();
        try {
            /* دوباره بررسی می‌کنیم: پروسهٔ دیگری ممکن است در همین فاصله مهاجرت کرده باشد. */
            if (!hasMeta(db, META_MIGRATED_FROM_PREFS)) {
                for (Alarm alarm : old) {
                    insertIgnore(db, alarm);
                }
                setMeta(db, META_MIGRATED_FROM_PREFS, corrupt ? "corrupt" : "1");
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }

        Log.i(TAG, "STORE_MIGRATION records=" + old.size()
                + " corrupt=" + corrupt
                + " prefsKept=true");
    }

    private interface DbWork<T> {
        T run(SQLiteDatabase db);
    }

    /**
     * اجرای یک عملیات با retry کوتاه روی خطاهای قفل. خطاهای دیگر فقط لاگ
     * می‌شوند و مقدار fallback برمی‌گردد؛ هیچ استثنايی به گیرندهٔ آلارم نمی‌رسد.
     */
    private static <T> T withDb(Context context, String operation, DbWork<T> work, T fallback) {
        Context app = context.getApplicationContext();

        for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                return work.run(database(app));
            } catch (SQLiteException e) {
                boolean busy = isBusy(e);
                if (!busy || attempt == MAX_ATTEMPTS - 1) {
                    Log.e(TAG, "STORE_" + operation + "_FAILED attempt=" + (attempt + 1), e);
                    break;
                }
                Log.w(TAG, "STORE_" + operation + "_BUSY attempt=" + (attempt + 1));
                sleepQuietly();
            } catch (Exception e) {
                Log.e(TAG, "STORE_" + operation + "_FAILED", e);
                break;
            }
        }

        return fallback;
    }

    private static boolean isBusy(SQLiteException e) {
        String message = e.getMessage();
        if (message == null) return false;
        String lower = message.toLowerCase();
        return lower.contains("locked") || lower.contains("busy");
    }

    private static void sleepQuietly() {
        try {
            Thread.sleep(RETRY_DELAY_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** همه‌ی آلارم‌های ذخیره‌شده، مرتب بر اساس زمان زنگ (صعودی). */
    public static List<Alarm> all(Context context) {
        return withDb(context, "ALL", db -> {
            List<Alarm> alarms = new ArrayList<>();
            try (Cursor cursor = db.query(
                    TABLE_ALARMS,
                    new String[]{"id", "task_id", "title", "at", "created_at"},
                    null,
                    null,
                    null,
                    null,
                    "at ASC, id ASC")) {

                while (cursor.moveToNext()) {
                    alarms.add(new Alarm(
                            cursor.getInt(0),
                            cursor.getInt(1),
                            cursor.getString(2),
                            cursor.getLong(3),
                            cursor.getLong(4)));
                }
            }
            return alarms;
        }, new ArrayList<>());
    }

    public static Alarm get(Context context, int id) {
        return withDb(context, "GET", db -> {
            try (Cursor cursor = db.query(
                    TABLE_ALARMS,
                    new String[]{"id", "task_id", "title", "at", "created_at"},
                    "id = ?",
                    new String[]{String.valueOf(id)},
                    null,
                    null,
                    null,
                    "1")) {

                if (!cursor.moveToFirst()) return null;

                return new Alarm(
                        cursor.getInt(0),
                        cursor.getInt(1),
                        cursor.getString(2),
                        cursor.getLong(3),
                        cursor.getLong(4));
            }
        }, null);
    }

    /**
     * ثبت/جایگزینی آلارم یک تسک (هر تسک حداکثر یک آلارم فعال دارد).
     *
     * @return true فقط اگر نوشتن واقعاً در پایگاه‌داده انجام شده باشد.
     */
    public static boolean put(Context context, Alarm alarm) {
        if (alarm == null) return false;

        return withDb(context, "PUT", db -> {
            long rowId = db.insertWithOnConflict(
                    TABLE_ALARMS, null, values(alarm), SQLiteDatabase.CONFLICT_REPLACE);
            return rowId != -1L;
        }, false);
    }

    /**
     * حذف یک آلارم.
     *
     * @return true اگر عملیات حذف با موفقیت اجرا شد (حتی اگر رکورد از قبل نبود).
     */
    public static boolean delete(Context context, int id) {
        return withDb(context, "DELETE", db -> {
            db.delete(TABLE_ALARMS, "id = ?", new String[]{String.valueOf(id)});
            return true;
        }, false);
    }

    /** آلارم‌های زمان‌گذشته پاک می‌شوند (نگه‌داشتنشان بی‌فایده است و لیست را رشد می‌دهد). */
    public static boolean prune(Context context, long now) {
        return withDb(context, "PRUNE", db -> {
            db.delete(TABLE_ALARMS, "at <= ?", new String[]{String.valueOf(now)});
            return true;
        }, false);
    }

    /* ------------------------------------------------------------------ */
    /* نشست فعال زنگ                                                       */
    /* ------------------------------------------------------------------ */

    /** نشست فعال را به‌صورت یک عکس لحظه‌ایِ سازگار برمی‌گرداند؛ null یعنی هیچ. */
    public static Session session(Context context) {
        return withDb(context, "SESSION", db -> {
            db.beginTransaction();
            try {
                Session session = readSession(db);
                db.setTransactionSuccessful();
                return session;
            } finally {
                db.endTransaction();
            }
        }, null);
    }

    /**
     * شروع اتمیک نشست جدید: پاک‌سازی نشست قبلی + حذف رکوردِ همان نشست (اگر
     * هنوز به همان زمان است) + ثبت توکن/شناسه/زمان‌های نشست جدید، همه در یک
     * تراکنش. اگر رکورد همان آلارم در این فاصله Snooze شده باشد، زمانش عوض
     * شده و حذف (که با {@code id + at} انجام می‌شود) به رکورد جدید دست نمی‌زند.
     *
     * <p>همچنین داخل همان تراکنش بررسی می‌شود که رکوردِ {@code alarm.id +
     * alarm.at} هنوز وجود دارد. اگر cancel/Snooze آن را حذف یا جابه‌جا کرده
     * باشد، هیچ نشستی نوشته نمی‌شود و {@link StartResult#aborted} برمی‌گردد
     * تا فراخواننده صدای همان تلاش را rollback کند.
     */
    public static StartResult startSession(
            Context context,
            Alarm alarm,
            String token,
            long since,
            long sinceElapsed) {

        if (alarm == null || token == null || token.isEmpty()) return StartResult.failed();

        return withDb(context, "START_SESSION", db -> {
            db.beginTransaction();
            try {
                Session previous = readSession(db);

                /*
                 * اگر رکوردِ همین آلارم با همین زمان دیگر وجود نداشته باشد،
                 * یعنی cancel/Snooze در همین فاصله آن را عوض یا حذف کرده
                 * است. در این حالت هیچ صدایی نباید شروع شود و نشست/رکورد
                 * قبلی هم نباید پایان داده شود؛ پس صرفاً ABORTED برمی‌گردانیم.
                 */
                if (!hasAlarm(db, alarm.id, alarm.at)) {
                    db.setTransactionSuccessful();
                    return StartResult.aborted(previous);
                }

                boolean previousRecordDeleted = false;

                if (previous != null
                        && (previous.alarmId != alarm.id || previous.at != alarm.at)
                        && previous.at > 0L) {
                    int rows = db.delete(
                            TABLE_ALARMS,
                            "id = ? AND at = ?",
                            new String[]{String.valueOf(previous.alarmId), String.valueOf(previous.at)});
                    previousRecordDeleted = rows > 0;
                }

                writeSession(db, alarm.id, token, since, sinceElapsed, alarm.at);
                db.setTransactionSuccessful();
                return new StartResult(true, false, previous, previousRecordDeleted);
            } finally {
                db.endTransaction();
            }
        }, StartResult.failed());
    }

    /**
     * پایان اتمیک نشست: فقط اگر شناسه و توکن با نشست فعال بخوانند، نشانگر
     * پاک می‌شود و در صورت درخواست، رکوردِ همان نشست (با تطبیق {@code at})
     * حذف می‌شود. اگر توکن نخواند یا رکورد در این فاصله Snooze شده باشد، هیچ
     * رکورد/زمان‌بندی جدیدی آسیب نمی‌بیند.
     */
    public static EndResult endSession(
            Context context,
            int alarmId,
            String token,
            boolean deleteRecord) {

        return withDb(context, "END_SESSION", db -> {
            db.beginTransaction();
            try {
                Session current = readSession(db);
                boolean hasSession = current != null && current.alarmId == alarmId;

                if (token != null) {
                    /* توکن‌دار: فقط مالک همان نشست اجازهٔ تغییر دارد. */
                    if (current == null) {
                        db.setTransactionSuccessful();
                        return new EndResult(EndStatus.NO_SESSION, false, null);
                    }
                    if (current.alarmId != alarmId || !token.equals(current.token)) {
                        db.setTransactionSuccessful();
                        return new EndResult(EndStatus.STALE, false, null);
                    }
                    hasSession = true;
                }

                boolean recordDeleted = false;

                if (hasSession) {
                    deleteSession(db);
                    if (deleteRecord && current.at > 0L) {
                        int rows = db.delete(
                                TABLE_ALARMS,
                                "id = ? AND at = ?",
                                new String[]{String.valueOf(alarmId), String.valueOf(current.at)});
                        recordDeleted = rows > 0;
                    }
                } else if (deleteRecord && token == null) {
                    /*
                     * بدون نشست فعال، حذف اداری مجاز است (مثلاً cancel یک
                     * آلارم زمان‌بندی‌شده). با توکن هرگز این کار را نمی‌کنیم:
                     * ممکن است توکن کهنه باشد و رکورد جدید همان شناسه را
                     * نباید قربانی کند.
                     */
                    db.delete(TABLE_ALARMS, "id = ?", new String[]{String.valueOf(alarmId)});
                    recordDeleted = true;
                }

                db.setTransactionSuccessful();
                if (hasSession) return new EndResult(EndStatus.ENDED, recordDeleted, current.token);
                return new EndResult(EndStatus.NO_SESSION, false, null);
            } finally {
                db.endTransaction();
            }
        }, EndResult.failed());
    }

    /**
     * تعویق اتمیک: رکورد با زمان جدید جایگزین می‌شود و همان تراکنش نشست فعال
     * را (اگر توکن بخواند) پاک می‌کند. اگر توکن کهنه باشد، نه رکورد عوض
     * می‌شود و نه نشست جدید لمس می‌شود.
     */
    public static SnoozeResult snoozeSession(Context context, Alarm next, String token) {
        if (next == null) return SnoozeResult.failed();

        return withDb(context, "SNOOZE_SESSION", db -> {
            db.beginTransaction();
            try {
                Session current = readSession(db);

                if (token != null) {
                    if (current == null
                            || current.alarmId != next.id
                            || !token.equals(current.token)) {
                        db.setTransactionSuccessful();
                        return new SnoozeResult(EndStatus.STALE, false);
                    }
                }

                long rowId = db.insertWithOnConflict(
                        TABLE_ALARMS, null, values(next), SQLiteDatabase.CONFLICT_REPLACE);

                if (rowId == -1L) {
                    db.setTransactionSuccessful();
                    return new SnoozeResult(EndStatus.FAILED, false);
                }

                /*
                 * بدون توکن هم اگر نشست فعالِ همین شناسه وجود داشته باشد
                 * پاکش می‌کنیم تا رکوردِ زمان جدید و نشانگر قدیمی ناسازگار
                 * نمانند. نشستِ شناسهٔ دیگر هرگز لمس نمی‌شود.
                 */
                boolean clearSession = token != null
                        || (current != null && current.alarmId == next.id);
                if (clearSession) deleteSession(db);

                db.setTransactionSuccessful();
                return new SnoozeResult(
                        clearSession ? EndStatus.ENDED : EndStatus.NO_SESSION, true);
            } finally {
                db.endTransaction();
            }
        }, SnoozeResult.failed());
    }

    /** شناسهٔ آلارم نشست فعال؛ -1 یعنی هیچ. */
    public static int activeAlarmId(Context context) {
        Session session = session(context);
        return session == null ? -1 : session.alarmId;
    }

    /** پاک‌سازی کامل و بدون شرط نشانگر نشست (فقط reboot/به‌روزرسانی). */
    public static boolean clearActiveAlways(Context context) {
        return withDb(context, "CLEAR_ACTIVE_ALWAYS", db -> {
            db.beginTransaction();
            try {
                deleteSession(db);
                db.setTransactionSuccessful();
                return true;
            } finally {
                db.endTransaction();
            }
        }, false);
    }

    /* ------------------------------------------------------------------ */
    /* ابزارهای پایگاه‌داده                                                */
    /* ------------------------------------------------------------------ */

    /** خواندن سازگار همهٔ فیلدهای نشست؛ اگر توکن قدیمی نبود، یک‌بار ساخته و ثبت می‌شود. */
    private static Session readSession(SQLiteDatabase db) {
        String idRaw = readMeta(db, META_ACTIVE_ALARM_ID);
        if (idRaw == null) return null;

        int alarmId;
        try {
            alarmId = Integer.parseInt(idRaw);
        } catch (NumberFormatException e) {
            return null;
        }
        if (alarmId < 0) return null;

        String sinceRaw = readMeta(db, META_ACTIVE_SINCE);
        String elapsedRaw = readMeta(db, META_ACTIVE_SINCE_ELAPSED);
        String atRaw = readMeta(db, META_ACTIVE_ALARM_AT);
        String token = readMeta(db, META_ACTIVE_SESSION_TOKEN);

        long since = parseLong(sinceRaw, 0L);
        long sinceElapsed = parseLong(elapsedRaw, 0L);
        long at = parseLong(atRaw, 0L);

        if (token == null || token.isEmpty()) {
            /*
             * دادهٔ قدیمی (نسخه‌ای که هنوز توکن نداشت). یک توکن پایدار می‌سازیم
             * تا فرمان‌های بعدی بتوانند مالکیت را تشخیص دهند؛ عمداً بر اساس
             * زمان شروع ساخته می‌شود تا خواندن دوباره توکن جدید نسازد.
             */
            token = "legacy-" + since;
            setMeta(db, META_ACTIVE_SESSION_TOKEN, token);
        }

        return new Session(alarmId, token, since, sinceElapsed, at);
    }

    private static void writeSession(
            SQLiteDatabase db,
            int alarmId,
            String token,
            long since,
            long sinceElapsed,
            long at) {
        setMeta(db, META_ACTIVE_ALARM_ID, String.valueOf(alarmId));
        setMeta(db, META_ACTIVE_SESSION_TOKEN, token);
        setMeta(db, META_ACTIVE_SINCE, String.valueOf(since));
        setMeta(db, META_ACTIVE_SINCE_ELAPSED, String.valueOf(sinceElapsed));
        setMeta(db, META_ACTIVE_ALARM_AT, String.valueOf(at));
    }

    private static void deleteSession(SQLiteDatabase db) {
        deleteMeta(db, META_ACTIVE_ALARM_ID);
        deleteMeta(db, META_ACTIVE_SESSION_TOKEN);
        deleteMeta(db, META_ACTIVE_SINCE);
        deleteMeta(db, META_ACTIVE_SINCE_ELAPSED);
        deleteMeta(db, META_ACTIVE_ALARM_AT);
    }

    /**
     * آیا رکورد آلارم با همین شناسه و همین زمان دقیقاً وجود دارد؟
     * فقط داخل تراکنشِ {@link #startSession} استفاده می‌شود تا بررسی وجود و
     * ثبت نشست اتمیک باشند.
     */
    private static boolean hasAlarm(SQLiteDatabase db, int id, long at) {
        try (Cursor cursor = db.query(
                TABLE_ALARMS,
                new String[]{"id"},
                "id = ? AND at = ?",
                new String[]{String.valueOf(id), String.valueOf(at)},
                null,
                null,
                null,
                "1")) {
            return cursor.moveToFirst();
        }
    }

    private static long parseLong(String raw, long fallback) {
        if (raw == null) return fallback;
        try {
            return Long.parseLong(raw);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static ContentValues values(Alarm alarm) {
        ContentValues values = new ContentValues();
        values.put("id", alarm.id);
        values.put("task_id", alarm.taskId);
        values.put("title", alarm.title);
        values.put("at", alarm.at);
        values.put("created_at", alarm.createdAt);
        return values;
    }

    private static void insertIgnore(SQLiteDatabase db, Alarm alarm) {
        db.insertWithOnConflict(TABLE_ALARMS, null, values(alarm), SQLiteDatabase.CONFLICT_IGNORE);
    }

    private static String readMeta(SQLiteDatabase db, String key) {
        try (Cursor cursor = db.query(
                TABLE_META,
                new String[]{"value"},
                "key = ?",
                new String[]{key},
                null,
                null,
                null,
                "1")) {

            if (!cursor.moveToFirst()) return null;
            return cursor.getString(0);
        }
    }

    private static boolean hasMeta(SQLiteDatabase db, String key) {
        return readMeta(db, key) != null;
    }

    private static void setMeta(SQLiteDatabase db, String key, String value) {
        ContentValues values = new ContentValues();
        values.put("key", key);
        values.put("value", value);
        db.insertWithOnConflict(TABLE_META, null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static void deleteMeta(SQLiteDatabase db, String key) {
        db.delete(TABLE_META, "key = ?", new String[]{key});
    }

    private static final class Helper extends SQLiteOpenHelper {

        Helper(Context context) {
            super(context, DB_NAME, null, DB_VERSION);
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            /*
             * IF NOT EXISTS عمدی است: دو پروسه ممکن است هم‌زمان اولین بار
             * پایگاه‌داده را باز کنند و یکی از آن‌ها در میانهٔ ساخت، جدول را
             * از قبل موجود ببیند. در آن حالت نباید کل باز شدن شکست بخورد.
             */
            db.execSQL(
                    "CREATE TABLE IF NOT EXISTS " + TABLE_ALARMS + " ("
                            + "id INTEGER PRIMARY KEY, "
                            + "task_id INTEGER NOT NULL, "
                            + "title TEXT NOT NULL DEFAULT '', "
                            + "at INTEGER NOT NULL, "
                            + "created_at INTEGER NOT NULL)");

            db.execSQL(
                    "CREATE INDEX IF NOT EXISTS idx_alarms_at ON "
                            + TABLE_ALARMS + "(at)");

            db.execSQL(
                    "CREATE TABLE IF NOT EXISTS " + TABLE_META + " ("
                            + "key TEXT PRIMARY KEY, "
                            + "value TEXT NOT NULL)");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            /*
             * نسخهٔ اول است؛ هیچ تغییر schemaای وجود ندارد. برای نسخه‌های بعدی
             * باید مهاجرت صریح و قابل‌بازگشت اینجا اضافه شود، نه DROP.
             */
            Log.w(TAG, "STORE_UPGRADE old=" + oldVersion + " new=" + newVersion);
        }
    }
}
