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
import org.json.JSONObject;

@CapacitorPlugin(name = "OneDropAuth")
public class OneDropAuthPlugin extends Plugin {
  private static final String REDIRECT = "msauth.com.sycamore.onedrop://auth";
  private AuthorizationService service;
  private SecureAuthStore store;
  private AuthState state;
  private boolean signingIn;
  private volatile int generation;

  @Override
  public void load() {
    service = new AuthorizationService(getContext());
    store = new SecureAuthStore(getContext());
  }

  private synchronized AuthState state() throws Exception {
    if (state == null) {
      String saved = store.read();
      state = saved == null ? new AuthState() : AuthState.jsonDeserialize(saved);
    }
    return state;
  }

  @PluginMethod
  public void status(PluginCall call) {
    try {
      if (!state().isAuthorized()) {
        call.resolve(signedOut());
        return;
      }
      freshToken(call, true);
    } catch (Exception error) {
      call.reject("The secure session could not be read. Sign out and try again.", error);
    }
  }

  @PluginMethod
  public synchronized void signIn(PluginCall call) {
    if (signingIn) {
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
      call.getData().put("_authGeneration", ++generation);
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
      signingIn = false;
      call.reject("A browser is required to sign in.", error);
    }
  }

  @ActivityCallback
  private synchronized void authorizationResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    int currentGeneration = call.getInt("_authGeneration", -1);
    if (currentGeneration != generation) {
      call.reject("Sign-in was cancelled.");
      return;
    }
    if (result.getData() == null) {
      signingIn = false;
      call.reject("Sign-in was cancelled.");
      return;
    }
    AuthorizationResponse response = AuthorizationResponse.fromIntent(result.getData());
    AuthorizationException error = AuthorizationException.fromIntent(result.getData());
    if (response == null || error != null) {
      signingIn = false;
      call.reject(error == null ? "Sign-in was cancelled." : "Microsoft sign-in failed.", error);
      return;
    }
    AuthState next = new AuthState(response, null);
    service.performTokenRequest(
        response.createTokenExchangeRequest(),
        (tokens, failure) -> {
          synchronized (OneDropAuthPlugin.this) {
            if (currentGeneration != generation) {
              call.reject("Sign-in was cancelled.");
              return;
            }
            signingIn = false;
            if (tokens == null || failure != null) {
              call.reject("Microsoft could not complete sign-in.", failure);
              return;
            }
            try {
              next.update(tokens, null);
              store.write(next.jsonSerializeString());
              state = next;
              call.resolve(signedIn(next));
            } catch (Exception exception) {
              call.reject("The secure session could not be saved.", exception);
            }
          }
        });
  }

  @PluginMethod
  public void getAccessToken(PluginCall call) {
    freshToken(call, false);
  }

  private synchronized void freshToken(PluginCall call, boolean statusOnly) {
    try {
      AuthState current = state();
      if (!current.isAuthorized()) {
        call.reject("Sign in to Microsoft to continue.");
        return;
      }
      int currentGeneration = generation;
      current.performActionWithFreshTokens(
          service,
          (token, idToken, error) -> {
            synchronized (OneDropAuthPlugin.this) {
              if (currentGeneration != generation) {
                call.reject("The Microsoft session changed.");
                return;
              }
              try {
                store.write(current.jsonSerializeString());
                if (error != null || token == null) {
                  if (!current.isAuthorized()) {
                    store.clear();
                    state = new AuthState();
                    if (statusOnly) {
                      call.resolve(signedOut());
                      return;
                    }
                  }
                  call.reject(
                      "Microsoft session refresh failed. Try again or sign in again.", error);
                  return;
                }
                call.resolve(
                    statusOnly ? signedIn(current) : new JSObject().put("accessToken", token));
              } catch (Exception exception) {
                call.reject("The secure session could not be saved.", exception);
              }
            }
          });
    } catch (Exception error) {
      call.reject("The secure session could not be read. Sign out and try again.", error);
    }
  }

  @PluginMethod
  public synchronized void signOut(PluginCall call) {
    try {
      generation++;
      signingIn = false;
      store.clear();
      state = new AuthState();
      call.resolve(signedOut());
    } catch (Exception error) {
      call.reject("The secure session could not be removed.", error);
    }
  }

  private JSObject signedOut() {
    return new JSObject().put("state", "signed-out").put("redirectUri", REDIRECT);
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
        .put("state", "signed-in")
        .put("redirectUri", REDIRECT)
        .put(
            "expiresAt",
            date.format(new Date(expires == null ? System.currentTimeMillis() : expires)))
        .put("account", account);
  }

  @Override
  protected void handleOnDestroy() {
    service.dispose();
  }
}
