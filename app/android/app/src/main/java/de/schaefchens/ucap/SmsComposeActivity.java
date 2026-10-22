package de.schaefchens.ucap;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * "Write an SMS" from another app (`smsto:`, the SMS role's compose part): opens UCAP with the number, where the
 * person writes and sends it.
 */
public class SmsComposeActivity extends Activity {
    static final String EXTRA_TO = "ucap.sms.compose";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Uri data = getIntent().getData();
        String to = data == null ? null : data.getSchemeSpecificPart();
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (to != null && !to.isEmpty()) open.putExtra(EXTRA_TO, to.split("[?;,]")[0].trim());
        String body = getIntent().getStringExtra("sms_body");
        if (body == null) body = getIntent().getStringExtra(Intent.EXTRA_TEXT);
        if (body != null) open.putExtra(EXTRA_TO + ".body", body);
        startActivity(open);
        finish();
    }
}
