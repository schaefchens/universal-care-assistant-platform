package de.schaefchens.ucap;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;

/**
 * The previews' jobs, in the previews process (JobScheduler, as SmsJob): a retry once a network is there, expedited
 * where Android allows (a reply the person waits for); and every 15 minutes while an app is watched, what the server
 * holds for this phone's previews (a push that never came) and what is left to report.
 */
public class PreviewJob extends JobService {
    private static final int RETRY = 4731;
    private static final int PERIODIC = 4732;

    @Override
    public boolean onStartJob(JobParameters params) {
        PreviewListener.WORK.execute(() -> {
            boolean left = false;
            try {
                PreviewDb.get(this).prune();
                left = !PreviewSender.take(this);
                left |= PreviewSync.run(this);
            } catch (Exception e) {
                android.util.Log.w("UCAP", "previews job: " + e.getClass().getSimpleName());
                left = true;
            }
            jobFinished(params, left && params.getJobId() == RETRY);
            // Only once this run is over: scheduling a running job again stops it.
            if (left && params.getJobId() != RETRY) retry(this);
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    static void retry(Context ctx) {
        JobInfo.Builder b = new JobInfo.Builder(RETRY, new ComponentName(ctx, PreviewJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setBackoffCriteria(10_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL);
        schedule(ctx, b, true);
    }

    /** Every 15 minutes while an app is watched, unless it is armed already. */
    static void periodic(Context ctx) {
        if (ctx.getSystemService(JobScheduler.class).getPendingJob(PERIODIC) != null) return;
        JobInfo.Builder b = new JobInfo.Builder(PERIODIC, new ComponentName(ctx, PreviewJob.class))
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
            android.util.Log.e("UCAP", "previews job not scheduled: " + e.getClass().getSimpleName());
        }
    }
}
