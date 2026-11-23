package com.sycamore.onedrop;

import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import net.openid.appauth.AuthState;
import net.openid.appauth.AuthorizationException;
import net.openid.appauth.AuthorizationRequest;
import net.openid.appauth.AuthorizationResponse;
import net.openid.appauth.AuthorizationService;
import net.openid.appauth.AuthorizationServiceConfiguration;
import net.openid.appauth.ResponseTypeValues;
import net.openid.appauth.TokenResponse;
import org.json.JSONObject;

@CapacitorPlugin(name = "OneDropAuth")
public class OneDropAuthPlugin extends Plugin {
  private static final String REDIRECT = "msauth.com.sycamore.onedrop://auth";
  private AuthorizationService service;
  private SecureAuthStore store;
  private AuthState state;
  private boolean signingIn;
  private volatile int generation;
  private String authorizationAttempt;
  private AuthState candidate;
  private String candidateOwner;
  private String candidateExpected;
  private int candidateGeneration;

  @Override
  public void load() {
    service = new AuthorizationService(getContext());
    store = new SecureAuthStore(getContext());
  }

  private JSONObject accounts;
  private synchronized JSONObject accounts() throws Exception {
    if (accounts == null) {
      String saved = store.read();
      JSONObject value = saved == null ? new JSONObject() : new JSONObject(saved);
      if (value.has("accountsVersion")) accounts = value;
      else {
        accounts = new JSONObject().put("accountsVersion", 1).put("tokens", new JSONObject()).put("lastUsed", new JSONObject()).put("required", new JSONObject());
        if (saved != null) {
          AuthState legacy = AuthState.jsonDeserialize(saved);
          if (legacy.getIdToken() != null) {
            String key = accountKey(legacy);
            accounts.getJSONObject("tokens").put(key, legacy.jsonSerialize());
            accounts.put("activeKey", key);
            accounts.getJSONObject("lastUsed").put(key, System.currentTimeMillis());
          }
        }
      }
    }
    return accounts;
  }
  private synchronized AuthState state() throws Exception {
    if (state == null) {
      JSONObject saved = accounts();
      JSONObject token = saved.getJSONObject("tokens").optJSONObject(saved.optString("activeKey"));
      state = token == null ? new AuthState() : AuthState.jsonDeserialize(token);
    }
    return state;
  }
  private void persistState(AuthState value) throws Exception {
    String key = accountKey(value);
    accounts().getJSONObject("tokens").put(key, value.jsonSerialize());
    store.write(accounts().toString());
  }
  @PluginMethod
  public synchronized void listAccounts(PluginCall call) {
    try {
      JSONObject saved = accounts();
      org.json.JSONArray rows = new org.json.JSONArray();
      java.util.Iterator<String> keys = saved.getJSONObject("tokens").keys();
      while (keys.hasNext()) {
        String key = keys.next();
        AuthState token = AuthState.jsonDeserialize(saved.getJSONObject("tokens").getJSONObject(key));
        JSONObject profile = signedIn(token).getJSONObject("account");
        profile.put("key", key).put("lastUsedAt", saved.getJSONObject("lastUsed").optLong(key))
            .put("signInRequired", saved.getJSONObject("required").optBoolean(key));
        rows.put(profile);
      }
      call.resolve(new JSObject().put("accounts", rows).put("activeKey", saved.optString("activeKey", null)));
    } catch (Exception error) { call.reject("The account list could not be read."); }
  }
  @PluginMethod
  public synchronized void switchAccount(PluginCall call) {
    try {
      String key = call.getString("accountKey", "");
      if (!accounts().getJSONObject("tokens").has(key)) throw new IllegalArgumentException();
      JSONObject updated = new JSONObject(accounts().toString());
      updated.put("activeKey", key);
      updated.getJSONObject("lastUsed").put(key, System.currentTimeMillis());
      store.write(updated.toString());
      accounts = updated;
      generation++; invalidateAuthorization(); state = null;
      call.resolve(signedIn(state()));
    } catch (Exception error) { call.reject("This account could not be selected."); }
  }
  @PluginMethod
  public synchronized void removeAccount(PluginCall call) {
    try {
      String key = call.getString("accountKey", "");
      if (key.equals(accounts().optString("activeKey"))) throw new IllegalStateException("Use Sign out for the current account.");
      forgetAccount(key);
      call.resolve();
    } catch (Exception error) { call.reject("This account could not be removed."); }
  }

  private void forgetAccount(String key) throws Exception {
      invalidateAuthorization();
      JSONObject saved = new JSONObject(accounts().toString());
      boolean wasActive = key.equals(saved.optString("activeKey"));
      saved.getJSONObject("tokens").remove(key);
      saved.getJSONObject("lastUsed").remove(key);
      saved.getJSONObject("required").remove(key);
      if (key.equals(saved.optString("activeKey"))) {
        saved.remove("activeKey");
        String next = null; long newest = -1;
        java.util.Iterator<String> keys = saved.getJSONObject("tokens").keys();
        while (keys.hasNext()) { String candidate = keys.next(); long used = saved.getJSONObject("lastUsed").optLong(candidate); if (used > newest) { next = candidate; newest = used; } }
        if (next != null) saved.put("activeKey", next);
      }
      store.write(saved.toString()); accounts = saved; if (wasActive) { generation++; signingIn = false; state = null; }
  }

  @PluginMethod
  public void status(PluginCall call) {
    try {
      if (state().getIdToken() == null) {
        call.resolve(signedOut());
        return;
      }
      freshToken(call, true);
    } catch (Exception error) {
      call.reject("The secure session could not be read. Sign out and try again.", error);
    }
  }

  @PluginMethod
  public synchronized void signIn(PluginCall call) { startSignIn(call, false); }

  @PluginMethod
  public synchronized void prepareSignIn(PluginCall call) { startSignIn(call, true); }

  private void startSignIn(PluginCall call, boolean deferred) {
    if (signingIn || candidate != null) {
      call.reject("Sign-in is already in progress.");
      return;
    }
    String clientId = call.getString("clientId", "").trim();
    String authority =
        call.getString("authority", "https://login.microsoftonline.com/common")
            .replaceAll("/+$", "");
    Uri issuer = Uri.parse(authority);
    if (clientId.isEmpty()
        || !"https".equals(issuer.getScheme())
        || !"login.microsoftonline.com".equals(issuer.getHost())) {
      call.reject("Microsoft authentication is not configured correctly.");
      return;
    }
    try {
      signingIn = true;
      authorizationAttempt = deferred ? call.getString("attemptId") : java.util.UUID.randomUUID().toString();
      if (authorizationAttempt == null || authorizationAttempt.isEmpty()) throw new IllegalArgumentException();
      call.getData().put("_authAttempt", authorizationAttempt);
      call.getData().put("_authGeneration", generation);
      call.getData().put("_deferred", deferred);
      call.getData().put("_originalActive", accounts().optString("activeKey", ""));
      AuthorizationServiceConfiguration config =
          new AuthorizationServiceConfiguration(
              Uri.parse(authority + "/oauth2/v2.0/authorize"),
              Uri.parse(authority + "/oauth2/v2.0/token"));
      // AppAuth generates and verifies state and S256 PKCE for the external browser flow.
      AuthorizationRequest request =
          new AuthorizationRequest.Builder(
                  config, clientId, ResponseTypeValues.CODE, Uri.parse(REDIRECT))
              .setScope("openid profile offline_access https://graph.microsoft.com/Files.ReadWrite")
              .setPrompt("select_account")
              .build();
      startActivityForResult(
          call, service.getAuthorizationRequestIntent(request), "authorizationResult");
    } catch (Exception error) {
      invalidateAuthorization();
      call.reject("A browser is required to sign in.", error);
    }
  }

  @ActivityCallback
  private synchronized void authorizationResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    int currentGeneration = call.getInt("_authGeneration", -1);
    if (currentGeneration != generation || authorizationAttempt == null || !authorizationAttempt.equals(call.getString("_authAttempt"))) {
      call.reject("Sign-in was cancelled.");
      return;
    }
    if (result.getData() == null) {
      invalidateAuthorization();
      call.reject("Sign-in was cancelled.");
      return;
    }
    AuthorizationResponse response = AuthorizationResponse.fromIntent(result.getData());
    AuthorizationException error = AuthorizationException.fromIntent(result.getData());
    if (response == null || error != null) {
      invalidateAuthorization();
      call.reject(error == null ? "Sign-in was cancelled." : "Microsoft sign-in failed.", error);
      return;
    }
    AuthState next = new AuthState(response, null);
    service.performTokenRequest(
        response.createTokenExchangeRequest(),
        (tokens, failure) -> {
          synchronized (OneDropAuthPlugin.this) {
            if (currentGeneration != generation || authorizationAttempt == null || !authorizationAttempt.equals(call.getString("_authAttempt"))) {
              call.reject("Sign-in was cancelled.");
              return;
            }
            signingIn = false;
            if (tokens == null || failure != null) {
              invalidateAuthorization();
              call.reject("Microsoft could not complete sign-in.", failure);
              return;
            }
            try {
              next.update(tokens, null);
              candidate = next;
              candidateGeneration = currentGeneration;
              candidateOwner = call.getString("_originalActive", "");
              candidateExpected = call.getString("reauthenticateKey", "");
              if (call.getBoolean("_deferred", false)) call.resolve(new JSObject().put("candidateId", authorizationAttempt));
              else call.resolve(commitCandidate(authorizationAttempt));
            } catch (Exception exception) {
              if (call.getString("_authAttempt", "").equals(authorizationAttempt)) invalidateAuthorization();
              call.reject("The secure session could not be saved.", exception);
            }
          }
        });
  }

  private JSObject commitCandidate(String id) throws Exception {
    if (candidate == null || id == null || !id.equals(authorizationAttempt)
        || candidateGeneration != generation || !candidateOwner.equals(accounts().optString("activeKey", "")))
      throw new IllegalStateException("The Microsoft session changed.");
    String key = accountKey(candidate);
    if (!candidateExpected.isEmpty() && !candidateExpected.equals(key)) throw new IllegalStateException("Sign in with the selected Microsoft account.");
    if (!accounts().getJSONObject("tokens").has(key) && accounts().getJSONObject("tokens").length() >= 3) throw new IllegalStateException("You can keep up to three accounts.");
    JSONObject updated = new JSONObject(accounts().toString());
    updated.put("activeKey", key);
    updated.getJSONObject("lastUsed").put(key, System.currentTimeMillis());
    updated.getJSONObject("required").put(key, false);
    updated.getJSONObject("tokens").put(key, candidate.jsonSerialize());
    JSObject result = signedIn(candidate);
    store.write(updated.toString());
    accounts = updated;
    state = candidate;
    generation++;
    invalidateAuthorization();
    return result;
  }

  private void invalidateAuthorization() {
    authorizationAttempt = null;
    candidate = null;
    signingIn = false;
  }

  // Called only when a new WebView mounts; do not disturb the saved active session.
  @PluginMethod
  public synchronized void resetAuthorization(PluginCall call) {
    invalidateAuthorization();
    call.resolve();
  }

  @PluginMethod
  public synchronized void commitSignIn(PluginCall call) {
    try { call.resolve(commitCandidate(call.getString("candidateId"))); }
    catch (Exception error) { call.reject(error.getMessage()); }
  }

  @PluginMethod
  public synchronized void discardSignIn(PluginCall call) {
    if (authorizationAttempt != null && authorizationAttempt.equals(call.getString("attemptId"))) invalidateAuthorization();
    call.resolve();
  }

  @PluginMethod
  public void getAccessToken(PluginCall call) {
    freshToken(call, false);
  }

  private synchronized void freshToken(PluginCall call, boolean statusOnly) {
    try {
      AuthState current = state();
      if (!current.isAuthorized()) {
        if (statusOnly && current.getIdToken() != null) { call.resolve(signedIn(current)); return; }
        call.reject("Sign in to Microsoft to continue.");
        return;
      }
      int currentGeneration = generation;
      String previousIdToken = current.getIdToken();
      String ownerKey = accountKey(current);
      String previousState = current.jsonSerializeString();
      if (accounts().getJSONObject("required").optBoolean(ownerKey)) {
        if (statusOnly) call.resolve(signedIn(current));
        else call.reject("Sign in again to sync this account.");
        return;
      }
      current.performActionWithFreshTokens(
          service,
          (token, idToken, error) -> {
            synchronized (OneDropAuthPlugin.this) {
              if (currentGeneration != generation) {
                call.reject("The Microsoft session changed.");
                return;
              }
              try {
                if (error != null || token == null) {
                  state = AuthState.jsonDeserialize(previousState);
                  if (!current.isAuthorized()) accounts().getJSONObject("required").put(ownerKey, true);
                  store.write(accounts().toString());
                  if (statusOnly) { call.resolve(signedIn(state)); return; }
                  call.reject(
                      "Microsoft session refresh failed. Try again or sign in again.", error);
                  return;
                }
                retainIdentityAfterRefresh(current, previousIdToken);
                if (!ownerKey.equals(accountKey(current))) throw new IllegalStateException("Account identity changed.");
                persistState(current);
                call.resolve(
                    statusOnly ? signedIn(current) : new JSObject().put("accessToken", token).put("accountKey", accountKey(current)));
              } catch (Exception exception) {
                call.reject("The secure session could not be saved.", exception);
              }
            }
          });
    } catch (Exception error) {
      call.reject("The secure session could not be read. Sign out and try again.", error);
    }
  }

  // AppAuth replaces its last TokenResponse on refresh even when id_token is omitted.
  // Keep identity from this same session without changing the new access-token lifetime.
  static void retainIdentityAfterRefresh(AuthState current, String previousIdToken) {
    TokenResponse latest = current.getLastTokenResponse();
    if (previousIdToken == null || latest == null || latest.idToken != null) return;
    TokenResponse retained = new TokenResponse.Builder(latest.request)
        .setTokenType(latest.tokenType)
        .setAccessToken(latest.accessToken)
        .setAccessTokenExpirationTime(latest.accessTokenExpirationTime)
        .setRefreshToken(latest.refreshToken)
        .setScope(latest.scope)
        .setAdditionalParameters(latest.additionalParameters)
        .setIdToken(previousIdToken)
        .build();
    current.update(retained, null);
  }

  @PluginMethod
  public synchronized void signOut(PluginCall call) {
    try {
      String key = accounts().optString("activeKey", "");
      if (!key.isEmpty()) forgetAccount(key);
      AuthState next = state();
      call.resolve(next.getIdToken() == null ? signedOut() : signedIn(next));
    } catch (Exception error) {
      call.reject("The secure session could not be removed.", error);
    }
  }

  private JSObject signedOut() {
    return new JSObject().put("state", "signed-out").put("redirectUri", REDIRECT);
  }

  private String accountKey(AuthState current) throws Exception {
    String token = current.getIdToken();
    if (token == null) throw new IllegalStateException("Microsoft account identity is missing.");
    String[] parts = token.split("\\.");
    if (parts.length != 3) throw new IllegalStateException("Microsoft account identity is invalid.");
    JSONObject claims = new JSONObject(new String(Base64.decode(parts[1], Base64.URL_SAFE), StandardCharsets.UTF_8));
    String issuer = claims.optString("iss");
    String subject = claims.optString("sub");
    if (issuer.isEmpty() || subject.isEmpty()) throw new IllegalStateException("Microsoft account identity is missing.");
    return new org.json.JSONArray().put(issuer).put(subject).toString();
  }

  private JSObject signedIn(AuthState current) throws Exception {
    JSObject account = new JSObject();
    String token = current.getIdToken();
    if (token != null) {
      String[] parts = token.split("\\.");
      if (parts.length == 3) {
        JSONObject claims =
            new JSONObject(
                new String(Base64.decode(parts[1], Base64.URL_SAFE), StandardCharsets.UTF_8));
        account.put("displayName", claims.optString("name"));
        account.put("username", claims.optString("preferred_username"));
      }
    }
    Long expires = current.getAccessTokenExpirationTime();
    SimpleDateFormat date = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    date.setTimeZone(TimeZone.getTimeZone("UTC"));
    return new JSObject()
        .put("accountKey", accountKey(current))
        .put("state", "signed-in")
        .put("redirectUri", REDIRECT)
        .put(
            "expiresAt",
            date.format(new Date(expires == null ? System.currentTimeMillis() : expires)))
        .put("account", account);
  }

  @Override
  protected void handleOnDestroy() {
    synchronized (this) { invalidateAuthorization(); generation++; }
    service.dispose();
  }
}
