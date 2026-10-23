package de.schaefchens.ucap;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.provider.Telephony;

/**
 * The SMS connection's jobs, in the SMS process (JobScheduler, as Outbox):
 * - a retry once a network is there, expedited where Android allows (a reply the person waits for);
 * - every 15 minutes while UCAP is the SMS app: what the server holds for this phone (a push that never came), and what
 *   is left to report;
 * - when Android's SMS store changes: an SMS others wrote there is reported within seconds. On Android 16 the dialler
 *   sends a quick reply to a call itself (measured: it never asks the SMS app), and Android keeps another app's sent
 *   SMS there too. Such a watch is one-shot and not kept over a restart: armed at connecting and after every run.
 */
public class SmsJob extends JobService {
    private static final int RETRY = 4721;
    private static final int PERIODIC = 4722;
    private static final int MMS = 4723;
    private static final int STORE = 4724;

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            boolean left = false;
            try {
                SmsDb.get(this).forgetOldSends();
                // MMS whose fetch failed: tried again when due (until they expire).
                MmsFetch.retryDue(this);
                if (SmsSync.connection(this) != null) {
                    left = !SmsSender.take(this);
                    left |= SmsSync.run(this);
                }
            } catch (Exception e) {
                android.util.Log.w("UCAP", "sms job: " + e.getClass().getSimpleName());
                left = true;
            }
            jobFinished(params, left && params.getJobId() == RETRY);
            // Only once this run is over: scheduling a running job again stops it.
            if (left && params.getJobId() != RETRY) retry(this);
            if (SmsSync.connection(this) != null) keepWatching(this);
        }, "ucap-sms-job").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    static void retry(Context ctx) {
        JobInfo.Builder b = new JobInfo.Builder(RETRY, new ComponentName(ctx, SmsJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setBackoffCriteria(10_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL);
        schedule(ctx, b, true);
    }

    static void periodic(Context ctx) {
        JobInfo.Builder b = new JobInfo.Builder(PERIODIC, new ComponentName(ctx, SmsJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(15 * 60_000L)
            .setPersisted(true);
        schedule(ctx, b, false);
    }

    /** Runs when Android's SMS store changed (a few seconds later, so a burst is one run). */
    static void watchStore(Context ctx) {
        JobInfo.Builder b = new JobInfo.Builder(STORE, new ComponentName(ctx, SmsJob.class))
            .addTriggerContentUri(new JobInfo.TriggerContentUri(Telephony.Sms.CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
            .setTriggerContentUpdateDelay(2_000)
            .setTriggerContentMaxDelay(10_000);
        schedule(ctx, b, false);
    }

    /** The store's watch again, unless it waits or runs already. */
    private static void keepWatching(Context ctx) {
        if (ctx.getSystemService(JobScheduler.class).getPendingJob(STORE) == null) watchStore(ctx);
    }

    /**
     * A connected phone's jobs, armed again where Android dropped them: an update of the app or a force stop cancels
     * every job it had (measured), and only connecting armed them.
     */
    static void ensure(Context ctx) {
        if (ctx.getSystemService(JobScheduler.class).getPendingJob(PERIODIC) == null) periodic(ctx);
        keepWatching(ctx);
    }

    /** The next try of an MMS fetch, at `atMs` (or when a network is there after it). */
    static void mmsRetry(Context ctx, long atMs) {
        if (atMs < 0) return;
        JobInfo.Builder b = new JobInfo.Builder(MMS, new ComponentName(ctx, SmsJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setMinimumLatency(Math.max(0, atMs - System.currentTimeMillis()))
            .setPersisted(true);
        schedule(ctx, b, false);
    }

    static void cancel(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        js.cancel(RETRY);
        js.cancel(PERIODIC);
        js.cancel(STORE);
    }

    private static void schedule(Context ctx, JobInfo.Builder b, boolean expedite) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        try {
            int r = JobScheduler.RESULT_FAILURE;
            if (expedite && Build.VERSION.SDK_INT >= 31) {
                try {
                    r = js.schedule(b.setExpedited(true).build());
                } catch (RuntimeException e) {
                    r = JobScheduler.RESULT_FAILURE;
                }
                if (r != JobScheduler.RESULT_SUCCESS) b.setExpedited(false);
            }
            if (r != JobScheduler.RESULT_SUCCESS) js.schedule(b.build());
        } catch (RuntimeException e) {
            android.util.Log.e("UCAP", "sms job not scheduled: " + e.getClass().getSimpleName());
        }
    }
}
