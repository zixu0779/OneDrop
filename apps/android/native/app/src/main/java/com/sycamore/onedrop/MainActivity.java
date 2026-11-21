package com.sycamore.onedrop;

import android.os.Bundle;
import android.view.View;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(OneDropAuthPlugin.class);
    registerPlugin(OneDropDownloadPlugin.class);
    super.onCreate(savedInstanceState);
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    ViewCompat.setOnApplyWindowInsetsListener(
        (View) bridge.getWebView().getParent(),
        (view, windowInsets) -> {
          androidx.core.graphics.Insets insets =
              windowInsets.getInsets(
                  WindowInsetsCompat.Type.systemBars()
                      | WindowInsetsCompat.Type.displayCutout()
                      | WindowInsetsCompat.Type.ime());
          view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
          return new WindowInsetsCompat.Builder(windowInsets)
              .setInsets(
                  WindowInsetsCompat.Type.systemBars()
                      | WindowInsetsCompat.Type.displayCutout()
                      | WindowInsetsCompat.Type.ime(),
                  androidx.core.graphics.Insets.NONE)
              .build();
        });
  }
}
