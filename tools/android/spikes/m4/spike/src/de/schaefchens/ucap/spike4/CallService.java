package de.schaefchens.ucap.spike4;

import android.content.Intent;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.InCallService;
import android.telecom.VideoProfile;

/** The phone role's in-call service (spike D): which calls it is told of, its own call screen, answer and end. */
public class CallService extends InCallService {
    static CallService self;
    static Call current;

    static String name(int s) {
        switch (s) {
            case Call.STATE_NEW: return "new";
            case Call.STATE_DIALING: return "dialing";
            case Call.STATE_RINGING: return "ringing";
            case Call.STATE_HOLDING: return "holding";
            case Call.STATE_ACTIVE: return "active";
            case Call.STATE_DISCONNECTED: return "disconnected";
            case Call.STATE_CONNECTING: return "connecting";
            case Call.STATE_DISCONNECTING: return "disconnecting";
            default: return String.valueOf(s);
        }
    }

    private final Call.Callback callback = new Call.Callback() {
        @Override
        public void onStateChanged(Call call, int state) {
            Ev.log("call.state", "state", name(state));
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        self = this;
        Ev.log("call.service_created");
    }

    @Override
    public void onCallAdded(Call call) {
        current = call;
        Ev.log("call.added", "state", name(call.getDetails().getState()), "direction", call.getDetails().getCallDirection());
        call.registerCallback(callback);
        try {
            startActivity(new Intent(this, CallActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            Ev.log("call.screen_started");
        } catch (Throwable t) {
            Ev.log("call.screen_failed", "error", Ev.err(t));
        }
    }

    @Override
    public void onCallRemoved(Call call) {
        Ev.log("call.removed", "cause", call.getDetails().getDisconnectCause().getCode());
        call.unregisterCallback(callback);
        if (current == call) current = null;
    }

    static void answer() {
        if (current == null) Ev.log("call.none");
        else current.answer(VideoProfile.STATE_AUDIO_ONLY);
    }

    static void hangup() {
        if (current == null) Ev.log("call.none");
        else current.disconnect();
    }

    static void reject() {
        if (current == null) Ev.log("call.none");
        else current.reject(false, null);
    }

    static void speaker() {
        if (self == null) Ev.log("call.no_service");
        else self.setAudioRoute(CallAudioState.ROUTE_SPEAKER);
    }
}
