package de.schaefchens.ucap.spike;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** The SMS role's compose screen, which other apps open (`smsto:`): here it only says that it was asked. */
public class ComposeActivity extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Intent i = getIntent();
        Spike.log("compose", "action", i.getAction(), "scheme", i.getData() == null ? null : i.getData().getScheme(), "body", i.getStringExtra("sms_body") != null);
        finish();
    }
}
