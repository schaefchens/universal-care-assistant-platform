package de.schaefchens.ucap;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;
import org.vosk.Model;

/**
 * LIVE mode's microphone (docs/plan-m2.md, L2): a foreground service of type "microphone" (Android 14+: started while
 * the app is in front, then it keeps listening), with a notification "UCAP hört zu" for as long as the microphone is
 * open; the system's own indicator shows it too. Capture through VOICE_COMMUNICATION, with the platform's echo
 * canceller, noise suppression and gain control, so UCAP's own voice reaches it as little as the device allows.
 * LiveListener decides what the sound is for. Nothing is stored: samples live in memory, utterances go to the app.
 */
public class VoiceCaptureService extends Service {
    static final String CHANNEL = "live";
    static final int NOTIFICATION_ID = 7301;
    private static final String TAG = "UcapLive";

    /** Where the service's events go (the plugin): set before it starts. */
    interface Sink {
        void listening();
        void keyword(String word, short[] following);
        void utterance(short[] pcm);
        void speech();
        void stopped(String reason);
    }

    static volatile Sink sink;
    private static volatile VoiceCaptureService current;
    /** The model stays loaded while the process lives: loading it takes half a second and 170 MB (docs/spikes/m2.md). */
    private static Model model;
    private static String modelPath;

    private Thread thread;
    private volatile boolean running;
    /** A gate change for the capture thread to apply (LiveListener is used by that thread only). */
    private volatile Boolean gate;
    /**
     * Debug builds: a recording heard instead of the microphone, in its own time (tools and tests drive LIVE mode
     * without a microphone that would hear the room).
     */
    private static final java.util.concurrent.ConcurrentLinkedQueue<short[]> injected = new java.util.concurrent.ConcurrentLinkedQueue<>();

    static void inject(short[] pcm) {
        injected.add(pcm);
    }

    static boolean isRunning() {
        return current != null;
    }

    static void setGate(boolean open) {
        VoiceCaptureService s = current;
        if (s != null) s.gate = open;
    }

    static void stopAll() {
        VoiceCaptureService s = current;
        if (s != null) s.stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // Restarted by the system without the app: LIVE starts again when the app comes to the front.
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification n = notice(intent.getStringExtra("title"), intent.getStringExtra("text"));
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NOTIFICATION_ID, n);
        } catch (Exception e) {
            // Android refuses a microphone service started from the background (ForegroundServiceStartNotAllowed).
            Log.w(TAG, "foreground refused: " + e.getClass().getSimpleName());
            report("background");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (thread != null) stopCapture();
        ArrayList<String> keywords = intent.getStringArrayListExtra("keywords");
        ArrayList<String> grammar = intent.getStringArrayListExtra("grammar");
        String path = intent.getStringExtra("model");
        double threshold = intent.getDoubleExtra("threshold", 0.5);
        current = this;
        running = true;
        thread = new Thread(() -> capture(keywords == null ? new ArrayList<>() : keywords, grammar, path, threshold), "ucap-live");
        thread.start();
        return START_NOT_STICKY;
    }

    private Notification notice(String title, String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, title == null ? "LIVE" : title, NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title == null ? "UCAP" : title)
            .setContentText(text == null ? "" : text)
            .setOngoing(true)
            .setContentIntent(pi)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    private void capture(List<String> keywords, List<String> grammar, String path, double threshold) {
        AudioRecord rec = null;
        KeywordSpotter spotter = null;
        List<Object> effects = new ArrayList<>();
        String reason = "ended";
        try {
            if (!keywords.isEmpty() && path != null) {
                synchronized (VoiceCaptureService.class) {
                    if (model == null || !path.equals(modelPath)) {
                        if (model != null) model.close();
                        model = new Model(path);
                        modelPath = path;
                    }
                }
                List<String> words = new ArrayList<>(keywords);
                if (grammar != null) for (String g : grammar) if (!words.contains(g)) words.add(g);
                spotter = new KeywordSpotter(model, words);
            }
            final LiveListener listener = new LiveListener(spotter, keywords, threshold, new LiveListener.Events() {
                @Override
                public void keyword(String word, short[] following) {
                    Sink s = sink;
                    if (s != null) s.keyword(word, following);
                }

                @Override
                public void utterance(short[] pcm) {
                    Sink s = sink;
                    if (s != null) s.utterance(pcm);
                }

                @Override
                public void speech() {
                    Sink s = sink;
                    if (s != null) s.speech();
                }
            });
            int min = AudioRecord.getMinBufferSize(LiveListener.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, LiveListener.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 6400) * 2);
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                reason = "unavailable";
                return;
            }
            int session = rec.getAudioSessionId();
            if (AcousticEchoCanceler.isAvailable()) effects.add(enable(AcousticEchoCanceler.create(session)));
            if (NoiseSuppressor.isAvailable()) effects.add(enable(NoiseSuppressor.create(session)));
            if (AutomaticGainControl.isAvailable()) effects.add(enable(AutomaticGainControl.create(session)));
            rec.startRecording();
            if (rec.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                reason = "unavailable";
                return;
            }
            report("listening");
            short[] buf = new short[1600];
            short[] playing = null;
            int playingAt = 0;
            while (running) {
                Boolean g = gate;
                if (g != null) {
                    gate = null;
                    listener.setGate(g);
                }
                int n = rec.read(buf, 0, buf.length);
                if (n < 0) {
                    reason = "unavailable";
                    return;
                }
                // An injected recording replaces what the microphone heard, piece by piece in its own time.
                if (playing == null) {
                    playing = injected.poll();
                    playingAt = 0;
                }
                if (playing != null) {
                    int k = Math.min(n, playing.length - playingAt);
                    System.arraycopy(playing, playingAt, buf, 0, k);
                    java.util.Arrays.fill(buf, k, n, (short) 0);
                    playingAt += k;
                    if (playingAt >= playing.length) playing = null;
                }
                if (n > 0) listener.feed(buf, n);
            }
        } catch (Throwable e) {
            Log.w(TAG, "capture failed: " + e.getClass().getSimpleName());
            reason = "unavailable";
        } finally {
            for (Object fx : effects) if (fx instanceof android.media.audiofx.AudioEffect) ((android.media.audiofx.AudioEffect) fx).release();
            if (rec != null) {
                try {
                    rec.stop();
                } catch (Exception ignored) {
                    // Not recording.
                }
                rec.release();
            }
            if (spotter != null) spotter.close();
            // Stopped on purpose (LIVE off, paused for good): no news for the app.
            if (running) report(reason);
            running = false;
        }
    }

    private static Object enable(android.media.audiofx.AudioEffect fx) {
        if (fx != null) fx.setEnabled(true);
        return fx;
    }

    private void report(String what) {
        Sink s = sink;
        if (s == null) return;
        if (what.equals("listening")) s.listening();
        else s.stopped(what);
        if (!what.equals("listening")) stopSelf();
    }

    private void stopCapture() {
        running = false;
        Thread t = thread;
        thread = null;
        if (t != null) {
            try {
                t.join(2000);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    @Override
    public void onDestroy() {
        stopCapture();
        if (current == this) current = null;
        super.onDestroy();
    }
}
