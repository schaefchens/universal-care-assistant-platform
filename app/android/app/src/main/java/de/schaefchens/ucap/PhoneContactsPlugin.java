package de.schaefchens.ucap;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.provider.ContactsContract.CommonDataKinds.Email;
import android.provider.ContactsContract.CommonDataKinds.Phone;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;

/**
 * The phone's address book, for UCAP's contacts (docs/plan-m3.md, K6: "imported where the person allows (through the
 * SMS role if it grants contacts, otherwise the system's contact picker)"): all of it where UCAP may read it (Android
 * grants READ_CONTACTS with the SMS role), else one number the person chooses in Android's picker, which needs no
 * permission. Names, numbers and addresses only, with their labels in the phone's language ("Mobil"); nothing is
 * kept here or logged.
 */
@CapacitorPlugin(name = "PhoneContacts")
public class PhoneContactsPlugin extends Plugin {
    private boolean mayReadAll() {
        return getContext().checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(new JSObject().put("all", mayReadAll()));
    }

    /** Every contact with a number or an address: {name, handles: [{kind, value, label}]}. */
    @PluginMethod
    public void readAll(PluginCall call) {
        if (!mayReadAll()) {
            call.reject("not allowed", "denied");
            return;
        }
        new Thread(() -> {
            try {
                call.resolve(new JSObject().put("contacts", readAddressBook()));
            } catch (Exception e) {
                call.reject("not read: " + e.getClass().getSimpleName(), "failed");
            }
        }, "ucap-contacts").start();
    }

    private JSArray readAddressBook() {
        ContentResolver cr = getContext().getContentResolver();
        Resources res = getContext().getResources();
        Map<Long, JSONObject> byContact = new LinkedHashMap<>();
        String[] cols = {ContactsContract.Data.CONTACT_ID, ContactsContract.Data.DISPLAY_NAME, ContactsContract.Data.MIMETYPE, ContactsContract.Data.DATA1, ContactsContract.Data.DATA2, ContactsContract.Data.DATA3};
        try (Cursor c = cr.query(ContactsContract.Data.CONTENT_URI, cols, ContactsContract.Data.MIMETYPE + " in (?, ?)", new String[] {Phone.CONTENT_ITEM_TYPE, Email.CONTENT_ITEM_TYPE}, ContactsContract.Data.CONTACT_ID)) {
            while (c != null && c.moveToNext()) {
                String value = c.getString(3);
                if (value == null || value.trim().isEmpty()) continue;
                long id = c.getLong(0);
                JSONObject contact = byContact.get(id);
                if (contact == null) {
                    contact = new JSObject().put("name", c.isNull(1) ? "" : c.getString(1)).put("handles", new JSArray());
                    byContact.put(id, contact);
                }
                boolean phone = Phone.CONTENT_ITEM_TYPE.equals(c.getString(2));
                int type = c.isNull(4) ? 0 : c.getInt(4);
                String custom = c.isNull(5) ? null : c.getString(5);
                CharSequence label = phone ? Phone.getTypeLabel(res, type, custom) : Email.getTypeLabel(res, type, custom);
                contact.optJSONArray("handles").put(new JSObject().put("kind", phone ? "phone" : "email").put("value", value.trim()).put("label", label == null ? null : label.toString()));
            }
        }
        JSArray out = new JSArray();
        for (JSONObject x : byContact.values()) out.put(x);
        return out;
    }

    /** One number the person chooses in Android's picker, with its contact's name: readable through the picker's grant. */
    @PluginMethod
    public void pick(PluginCall call) {
        startActivityForResult(call, new Intent(Intent.ACTION_PICK, Phone.CONTENT_URI), "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        String[] cols = {Phone.DISPLAY_NAME, Phone.NUMBER, Phone.TYPE, Phone.LABEL};
        try (Cursor c = getContext().getContentResolver().query(uri, cols, null, null, null)) {
            if (c == null || !c.moveToFirst() || c.isNull(1)) {
                call.resolve(new JSObject().put("cancelled", true));
                return;
            }
            CharSequence label = Phone.getTypeLabel(getContext().getResources(), c.isNull(2) ? 0 : c.getInt(2), c.isNull(3) ? null : c.getString(3));
            JSArray handles = new JSArray();
            handles.put(new JSObject().put("kind", "phone").put("value", c.getString(1).trim()).put("label", label == null ? null : label.toString()));
            call.resolve(new JSObject().put("contact", new JSObject().put("name", c.isNull(0) ? "" : c.getString(0)).put("handles", handles)));
        } catch (Exception e) {
            call.reject("not read: " + e.getClass().getSimpleName(), "failed");
        }
    }
}
