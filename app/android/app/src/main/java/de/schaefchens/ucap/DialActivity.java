package de.schaefchens.ucap;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * Android's "dial" (docs/plan-m4.md, G10): the phone role goes only to an app that dials. Another app's number comes to
 * UCAP, which asks the person before it calls; nothing is dialled from here.
 */
public class DialActivity extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Uri data = getIntent().getData();
        PhonePlugin.pendingDial = data != null && "tel".equals(data.getScheme()) ? data.getSchemeSpecificPart() : "";
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
        finish();
    }
}
