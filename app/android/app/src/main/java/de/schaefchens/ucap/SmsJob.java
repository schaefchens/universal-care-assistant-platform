package de.schaefchens.ucap;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;

/**
 * The SMS connection's jobs, in the SMS process (JobScheduler, as Outbox):
 * - a retry once a network is there, expedited where Android allows (a reply the person waits for);
 * - every 15 minutes while UCAP is the SMS app: what the server holds for this phone (a push that never came), and what
 *   is left to report.
 */
public class SmsJob extends JobService {
    private static final int RETRY = 4721;
    private static final int PERIODIC = 4722;

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            boolean left = false;
            try {
                SmsDb.get(this).forgetOldSends();
                if (SmsSync.connection(this) != null) {
                    left = !SmsSender.take(this);
                    left |= SmsSync.run(this);
                }
            } catch (Exception e) {
                android.util.Log.w("UCAP", "sms job: " + e.getClass().getSimpleName());
                left = true;
            }
            jobFinished(params, left && params.getJobId() == RETRY);
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

    static void cancel(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        js.cancel(RETRY);
        js.cancel(PERIODIC);
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
