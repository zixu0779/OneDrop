package com.sycamore.onedrop;

import static org.junit.Assert.*;
import android.net.Uri;
import android.util.Base64;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.InvocationTargetException;
import java.nio.charset.StandardCharsets;
import net.openid.appauth.AuthState;
import net.openid.appauth.AuthorizationServiceConfiguration;
import net.openid.appauth.TokenRequest;
import net.openid.appauth.TokenResponse;
import org.json.JSONObject;
import org.junit.Test;

public class AuthCandidateTest {
  private void set(OneDropAuthPlugin plugin, String name, Object value) throws Exception {
    Field field = OneDropAuthPlugin.class.getDeclaredField(name); field.setAccessible(true); field.set(plugin, value);
  }
  private Object get(OneDropAuthPlugin plugin, String name) throws Exception {
    Field field = OneDropAuthPlugin.class.getDeclaredField(name); field.setAccessible(true); return field.get(plugin);
  }
  private AuthState token(String subject) throws Exception {
    AuthorizationServiceConfiguration config = new AuthorizationServiceConfiguration(Uri.parse("https://example.org/authorize"), Uri.parse("https://example.org/token"));
    TokenRequest request = new TokenRequest.Builder(config, "test").setGrantType("refresh_token").setRefreshToken("synthetic").build();
    String claims = new JSONObject().put("iss", "synthetic").put("sub", subject).toString();
    String id = "header." + Base64.encodeToString(claims.getBytes(StandardCharsets.UTF_8), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING) + ".signature";
    AuthState state = new AuthState(config);
    state.update(new TokenResponse.Builder(request).setAccessToken("synthetic").setIdToken(id).build(), null);
    return state;
  }
  @Test public void candidateDoesNotPersistUntilValidatedCommitAndCannotReplay() throws Exception {
    OneDropAuthPlugin plugin = new OneDropAuthPlugin();
    SecureAuthStore store = new SecureAuthStore(InstrumentationRegistry.getInstrumentation().getTargetContext(), "candidate-test-only");
    store.clear();
    try {
      JSONObject saved = new JSONObject().put("accountsVersion", 1).put("activeKey", "old").put("tokens", new JSONObject()).put("lastUsed", new JSONObject()).put("required", new JSONObject());
      set(plugin, "store", store); set(plugin, "accounts", saved);
      set(plugin, "authorizationAttempt", "attempt"); set(plugin, "candidate", token("new"));
      set(plugin, "candidateOwner", "old"); set(plugin, "candidateExpected", ""); set(plugin, "candidateGeneration", 0);
      Method commit = OneDropAuthPlugin.class.getDeclaredMethod("commitCandidate", String.class); commit.setAccessible(true);
      assertNull(store.read()); assertEquals("old", saved.getString("activeKey")); assertEquals(0, get(plugin, "generation"));
      try { commit.invoke(plugin, "stale-attempt"); fail(); } catch (InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }
      set(plugin, "candidateExpected", "different-account");
      try { commit.invoke(plugin, "attempt"); fail(); } catch (InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }
      assertNull(store.read());
      set(plugin, "candidateExpected", ""); set(plugin, "generation", 1);
      try { commit.invoke(plugin, "attempt"); fail(); } catch (InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }
      assertNull(store.read()); set(plugin, "generation", 0);
      set(plugin, "candidateOwner", "other-active");
      try { commit.invoke(plugin, "attempt"); fail(); } catch (InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }
      set(plugin, "candidateOwner", "old");
      saved.getJSONObject("tokens").put("one", new JSONObject()).put("two", new JSONObject()).put("three", new JSONObject());
      try { commit.invoke(plugin, "attempt"); fail(); } catch (InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }
      assertNull(store.read()); saved.put("tokens", new JSONObject());
      commit.invoke(plugin, "attempt");
      JSONObject committed = new JSONObject(store.read()); assertNotEquals("old", committed.getString("activeKey")); assertEquals(1, get(plugin, "generation")); assertNull(get(plugin, "candidate"));
      try { commit.invoke(plugin, "attempt"); fail(); } catch (InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }
      String persisted = store.read();
      set(plugin, "authorizationAttempt", "orphan"); set(plugin, "candidate", token("orphan")); set(plugin, "signingIn", true);
      Method reset = OneDropAuthPlugin.class.getDeclaredMethod("invalidateAuthorization"); reset.setAccessible(true); reset.invoke(plugin);
      assertNull(get(plugin, "candidate")); assertNull(get(plugin, "authorizationAttempt")); assertEquals(false, get(plugin, "signingIn")); assertEquals(1, get(plugin, "generation")); assertEquals(persisted, store.read());
      try { commit.invoke(plugin, "orphan"); fail(); } catch (InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IllegalStateException); }
    } finally { store.clear(); }
  }
}
