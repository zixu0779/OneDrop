package com.sycamore.onedrop;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureAuthStore {
  private static final String ALIAS = "onedrop.microsoft-auth";
  private final SharedPreferences preferences;

  SecureAuthStore(Context context) {
    this(context, "onedrop-auth");
  }

  SecureAuthStore(Context context, String preferencesName) {
    preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE);
  }

  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (!store.containsAlias(ALIAS)) {
      KeyGenerator generator =
          KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(
          new KeyGenParameterSpec.Builder(
                  ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .build());
      return generator.generateKey();
    }
    return (SecretKey) store.getKey(ALIAS, null);
  }

  synchronized String read() throws Exception {
    String data = preferences.getString("state", null);
    if (data == null) return null;
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(
        Cipher.DECRYPT_MODE,
        key(),
        new GCMParameterSpec(128, Base64.decode(preferences.getString("iv", ""), Base64.NO_WRAP)));
    return new String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), StandardCharsets.UTF_8);
  }

  synchronized void write(String state) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    String data =
        Base64.encodeToString(
            cipher.doFinal(state.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
    if (!preferences
        .edit()
        .putString("state", data)
        .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
        .commit()) {
      throw new IllegalStateException("The secure session could not be saved.");
    }
  }

  synchronized void clear() throws Exception {
    if (!preferences.edit().clear().commit()) {
      throw new IllegalStateException("The secure session could not be removed.");
    }
  }
}
