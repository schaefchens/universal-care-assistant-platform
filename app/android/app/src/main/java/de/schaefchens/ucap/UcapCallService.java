package de.schaefchens.ucap;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.InCallService;
import android.telecom.VideoProfile;

/**
 * UCAP as the phone app (docs/plan-m4.md, G10; spikes/m4.md, D): once UCAP holds Android's phone role, Android tells this
 * service of every call. Its own call screen (CallActivity: native, over the lock screen and inside the kiosk) says who
 * calls and offers large areas. Every call that ends is kept by Calls for the app, which says missed ones and tells the
 * server who called, when and how.
 */
public class UcapCallService extends InCallService {
    static volatile Call current;
    static volatile UcapCallService self;

    private final Call.Callback callback = new Call.Callback() {
        @Override
        public void onStateChanged(Call call, int state) {
            if (state == Call.STATE_ACTIVE) Calls.answered(call);
            if (state == Call.STATE_DISCONNECTED) Calls.ended(UcapCallService.this, call);
            CallActivity.refresh();
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        self = this;
    }

    @Override
    public void onDestroy() {
        ongoing(false);
        if (self == this) self = null;
        super.onDestroy();
    }

    @Override
    public void onCallAdded(Call call) {
        current = call;
        call.registerCallback(callback);
        Calls.started(call);
        CallActivity.open(this);
        ongoing(true);
        PhonePlugin.callsChanged();
    }

    private static final String ONGOING_CHANNEL = "ucap-call-now";
    private static final int ONGOING_ID = 4302;

    /**
     * While a call lasts, a notification leads back to its screen (the person may have gone to UCAP for help, or
     * elsewhere): as a phone app's, quiet, and naming nobody on the lock screen.
     */
    private void ongoing(boolean on) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (!on) {
            nm.cancel(ONGOING_ID);
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(ONGOING_CHANNEL) == null) nm.createNotificationChannel(new NotificationChannel(ONGOING_CHANNEL, Texts.get(this, "calls.ongoingChannel"), NotificationManager.IMPORTANCE_LOW));
        PendingIntent back = PendingIntent.getActivity(this, ONGOING_ID, new Intent(this, CallActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        @SuppressWarnings("deprecation")
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, ONGOING_CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.sym_action_call).setContentTitle(Texts.get(this, "calls.ongoing")).setContentText(Texts.get(this, "calls.ongoingBack")).setContentIntent(back).setOngoing(true).setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PUBLIC);
        nm.notify(ONGOING_ID, b.build());
    }

    @Override
    public void onCallRemoved(Call call) {
        call.unregisterCallback(callback);
        if (current == call) current = null;
        if (getCalls().isEmpty()) ongoing(false);
        PhonePlugin.callsChanged();
        CallActivity.refresh();
    }

    static void answer() {
        Call c = current;
        if (c != null) c.answer(VideoProfile.STATE_AUDIO_ONLY);
    }

    static void decline() {
        Call c = current;
        if (c != null) c.reject(false, null);
    }

    static void hangup() {
        Call c = current;
        if (c != null) c.disconnect();
    }

    static void speaker(boolean on) {
        UcapCallService s = self;
        if (s != null) s.setAudioRoute(on ? CallAudioState.ROUTE_SPEAKER : CallAudioState.ROUTE_EARPIECE);
    }

    static boolean onSpeaker() {
        UcapCallService s = self;
        CallAudioState a = s == null ? null : s.getCallAudioState();
        return a != null && a.getRoute() == CallAudioState.ROUTE_SPEAKER;
    }
}
