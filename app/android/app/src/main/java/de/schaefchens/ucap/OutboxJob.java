package de.schaefchens.ucap;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Runs the native outbox when Android sees a network (Outbox). JobScheduler, not WorkManager: see docs/decisions.md. */
public class OutboxJob extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            boolean left = Outbox.drain(getApplicationContext());
            jobFinished(params, left);
        }, "ucap-outbox").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // stopped before it finished: try again later
    }
}
