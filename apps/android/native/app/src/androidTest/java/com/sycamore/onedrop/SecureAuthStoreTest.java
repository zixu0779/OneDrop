package com.sycamore.onedrop;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;

public class SecureAuthStoreTest {
  @Test
  public void persistsEncryptedStateAcrossInstancesAndClearsIt() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    SecureAuthStore store = new SecureAuthStore(context, "onedrop-auth-test");
    store.clear();
    assertNull(store.read());
    store.write("{\"refresh_token\":\"test-secret\"}");
    String encrypted =
        context
            .getSharedPreferences("onedrop-auth-test", Context.MODE_PRIVATE)
            .getString("state", "");
    assertFalse(encrypted.contains("test-secret"));
    assertEquals(
        "{\"refresh_token\":\"test-secret\"}",
        new SecureAuthStore(context, "onedrop-auth-test").read());
    store.clear();
    assertNull(new SecureAuthStore(context, "onedrop-auth-test").read());
  }
}
