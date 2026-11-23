package com.sycamore.onedrop;

import static org.junit.Assert.*;

import android.net.Uri;
import net.openid.appauth.AuthState;
import net.openid.appauth.AuthorizationServiceConfiguration;
import net.openid.appauth.TokenRequest;
import net.openid.appauth.TokenResponse;
import org.junit.Test;

public class AuthIdentityRefreshTest {
  @Test
  public void retainsIdentityWhenRefreshOmitsIdTokenWithoutChangingNewTokenLifetime() throws Exception {
    AuthorizationServiceConfiguration configuration = new AuthorizationServiceConfiguration(
        Uri.parse("https://example.org/authorize"), Uri.parse("https://example.org/token"));
    TokenRequest request = new TokenRequest.Builder(configuration, "synthetic-client")
        .setGrantType("refresh_token").setRefreshToken("old-refresh").build();
    AuthState state = new AuthState(configuration);
    state.update(new TokenResponse.Builder(request).setAccessToken("old-access")
        .setIdToken("original-identity").setRefreshToken("old-refresh")
        .setAccessTokenExpirationTime(1L).build(), null);
    String previousIdentity = state.getIdToken();
    long refreshedExpiry = System.currentTimeMillis() + 3600000;
    state.update(new TokenResponse.Builder(request).setAccessToken("new-access")
        .setRefreshToken("new-refresh").setAccessTokenExpirationTime(refreshedExpiry).build(), null);
    assertNull(state.getIdToken()); // Reproduces AppAuth 0.11.1's omitted-id_token behavior.
    OneDropAuthPlugin.retainIdentityAfterRefresh(state, previousIdentity);
    AuthState restored = AuthState.jsonDeserialize(state.jsonSerializeString());
    assertEquals("original-identity", restored.getIdToken());
    assertEquals("new-access", restored.getAccessToken());
    assertEquals("new-refresh", restored.getRefreshToken());
    assertEquals(Long.valueOf(refreshedExpiry), restored.getAccessTokenExpirationTime());
    state.update(new TokenResponse.Builder(request).setAccessToken("next-access")
        .setIdToken("fresh-identity").build(), null);
    OneDropAuthPlugin.retainIdentityAfterRefresh(state, previousIdentity);
    assertEquals("fresh-identity", state.getIdToken());
    AuthState signedOut = new AuthState();
    OneDropAuthPlugin.retainIdentityAfterRefresh(signedOut, null);
    assertNull(signedOut.getIdToken());
  }
}
