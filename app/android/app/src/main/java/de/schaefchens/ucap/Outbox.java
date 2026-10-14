package de.schaefchens.ucap;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Signed requests that could not go out at once (offline, the server down): kept in order and sent again.
 * Receipts, the alarm's answers, endpoint registrations. Each keeps its idempotency key, so a request the server did
 * get before the connection broke counts once (I6).
 * - While the app's process lives, quick tries first: 2, 4, 8, 15, 30 and 60 s after the failure.
 * - OutboxJob (JobScheduler) as the durable way: expedited where Android has it, so it runs as soon as a network is
 *   there. Measured on the emulator (Android 16): an ordinary job whose 10 s backoff had passed was still not run
 *   four minutes later; a helper's answer cannot wait like that.
 */
final class Outbox {
    private static final String PREFS = "ucap.outbox";
    private static final int JOB_ID = 4711;
    private static final int MAX = 100;
    private static final Object LOCK = new Object();
    /** One drain at a time: the job and the quick tries never send the same entry twice at once. */
    private static final Object DRAIN = new Object();
    private static final long[] QUICK_MS = { 2000, 4000, 8000, 15000, 30000, 60000 };
    private static Thread quick;

    private Outbox() {}

    static JSONObject entry(String kind, String method, String path, String bodyJcs, String idem) {
        try {
            return new JSONObject().put("kind", kind).put("m", method).put("p", path).put("b", bodyJcs == null ? JSONObject.NULL : bodyJcs).put("idem", idem).put("created", System.currentTimeMillis());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static JSONArray load(SharedPreferences p) {
        try {
            return new JSONArray(p.getString("queue", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static void add(Context ctx, JSONObject entry) {
        synchronized (LOCK) {
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray q = load(p);
            q.put(entry);
            // Full: the oldest receipt goes first; answers and registrations are kept longest.
            while (q.length() > MAX) {
                int drop = 0;
                for (int i = 0; i < q.length(); i++) if ("receipt".equals(q.optJSONObject(i).optString("kind"))) { drop = i; break; }
                q.remove(drop);
            }
            p.edit().putString("queue", q.toString()).commit();
        }
        schedule(ctx);
        tryQuickly(ctx.getApplicationContext());
    }

    /** The quick tries, while the process lives; ends when the outbox is empty. */
    private static void tryQuickly(Context ctx) {
        synchronized (LOCK) {
            if (quick != null && quick.isAlive()) return;
            quick = new Thread(() -> {
                for (long wait : QUICK_MS) {
                    try {
                        Thread.sleep(wait);
                    } catch (InterruptedException e) {
                        return;
                    }
                    if (!drain(ctx)) return;
                }
            }, "ucap-outbox-quick");
            quick.start();
        }
    }

    static int size(Context ctx) {
        synchronized (LOCK) {
            return load(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)).length();
        }
    }

    static void schedule(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        JobInfo.Builder b = new JobInfo.Builder(JOB_ID, new ComponentName(ctx, OutboxJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setBackoffCriteria(10_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
            .setPersisted(true);
        try {
            int r = JobScheduler.RESULT_FAILURE;
            if (Build.VERSION.SDK_INT >= 31) {
                try {
                    r = js.schedule(b.setExpedited(true).build());
                } catch (RuntimeException e) {
                    r = JobScheduler.RESULT_FAILURE;
                }
                // Out of expedited quota: an ordinary job, which Android may run later.
                if (r != JobScheduler.RESULT_SUCCESS) b.setExpedited(false);
            }
            if (r != JobScheduler.RESULT_SUCCESS) r = js.schedule(b.build());
            if (r != JobScheduler.RESULT_SUCCESS) android.util.Log.e("UCAP", "outbox job refused by JobScheduler");
        } catch (RuntimeException e) {
            // Never silent: what waits here is a helper's answer or a receipt.
            android.util.Log.e("UCAP", "outbox job not scheduled: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    /** How long an entry is worth sending: an answer or a receipt for an hour, a registration for a week. */
    private static long maxAge(String kind) {
        return "endpoint".equals(kind) || "unregister".equals(kind) ? 7 * 86_400_000L : 3_600_000L;
    }

    /** Sends what is waiting, in order; true when something is left for a later try. */
    static boolean drain(Context ctx) {
        synchronized (DRAIN) {
            return drainNow(ctx);
        }
    }

    private static boolean drainNow(Context ctx) {
        while (true) {
            JSONObject e;
            synchronized (LOCK) {
                JSONArray q = load(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
                if (q.length() == 0) return false;
                e = q.optJSONObject(0);
            }
            Api.Result r;
            if (System.currentTimeMillis() - e.optLong("created") > maxAge(e.optString("kind"))) r = null;
            else {
                r = Api.signedJcs(ctx, e.optString("m"), e.optString("p"), e.isNull("b") ? null : e.optString("b"), e.optString("idem"), 10_000);
                if (r.retry()) return true;
            }
            synchronized (LOCK) {
                SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                JSONArray q = load(p);
                if (q.length() > 0 && e.optString("idem").equals(q.optJSONObject(0).optString("idem"))) q.remove(0);
                p.edit().putString("queue", q.toString()).commit();
            }
            outcome(ctx, e, r);
        }
    }

    /** What a late answer changes on the phone; r is null when the entry expired unsent. */
    private static void outcome(Context ctx, JSONObject e, Api.Result r) {
        switch (e.optString("kind")) {
            case "action":
                Actions.outcome(ctx, e.optString("rid"), e.optString("action"), e.optString("who"), r);
                break;
            case "endpoint":
                if (r != null) Endpoints.outcome(ctx, e.optString("endpoint"), r);
                break;
            default:
                break;
        }
    }

    static void clear(Context ctx) {
        synchronized (LOCK) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit();
        }
    }
}
