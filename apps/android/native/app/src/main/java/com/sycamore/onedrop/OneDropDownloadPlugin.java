package com.sycamore.onedrop;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "OneDropDownload")
public class OneDropDownloadPlugin extends Plugin {
  private final ExecutorService executor = Executors.newCachedThreadPool();
  private final Map<String, AtomicBoolean> downloads = new ConcurrentHashMap<>();

  private String required(PluginCall call, String key) {
    String value = call.getString(key, "");
    if (value.isEmpty()) throw new IllegalArgumentException("Missing " + key + ".");
    return value;
  }

  private File directory(String id) throws Exception {
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8));
    StringBuilder name = new StringBuilder();
    for (byte value : hash) name.append(String.format("%02x", value));
    return new File(getContext().getFilesDir(), "downloads/" + name);
  }

  private File stored(String id) throws Exception {
    String name =
        getContext().getSharedPreferences("downloads", Context.MODE_PRIVATE).getString(id, null);
    if (name == null) return null;
    File file = new File(directory(id), safeName(name));
    return file.isFile() ? file : null;
  }

  static String safeName(String name) {
    String safe = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
    if (safe.isEmpty() || safe.equals(".") || safe.equals("..")) return "download";
    return safe.length() > 180 ? safe.substring(safe.length() - 180) : safe;
  }

  @PluginMethod
  public void previousDownloads(PluginCall call) {
    try {
      org.json.JSONArray files = new org.json.JSONArray();
      for (String id : getContext().getSharedPreferences("downloads", Context.MODE_PRIVATE).getAll().keySet()) {
        if (id.matches("[0-9a-f]{64}:.*")) continue;
        File file = stored(id);
        if (file != null) files.put(new JSObject().put("id", id).put("name", file.getName()));
      }
      call.resolve(new JSObject().put("files", files));
    } catch (Exception error) { call.reject("Previous downloads could not be listed.", error); }
  }

  @PluginMethod
  public void download(PluginCall call) {
    final String id;
    final String name;
    final URL url;
    try {
      id = required(call, "driveItemId");
      name = safeName(required(call, "fileName"));
      url = new URL(required(call, "url"));
      if (!"https".equals(url.getProtocol()))
        throw new IllegalArgumentException("A secure download URL is required.");
    } catch (Exception error) {
      call.reject(error.getMessage(), error);
      return;
    }
    AtomicBoolean cancelled = new AtomicBoolean();
    if (downloads.putIfAbsent(id, cancelled) != null) {
      call.reject("This file is already downloading.");
      return;
    }
    executor.execute(
        () -> {
          HttpURLConnection connection = null;
          File partial = null;
          try {
            File folder = directory(id);
            if (!folder.isDirectory() && !folder.mkdirs())
              throw new IllegalStateException("The download folder could not be created.");
            File temporary = new File(getContext().getCacheDir(), "downloads");
            if (!temporary.isDirectory() && !temporary.mkdirs())
              throw new IllegalStateException("The temporary folder could not be created.");
            partial = File.createTempFile("download-", ".partial", temporary);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(30_000);
            connection.setReadTimeout(30_000);
            if (connection.getResponseCode() != 200)
              throw new IllegalStateException("The download failed. Refresh and try again.");
            long total = connection.getContentLengthLong();
            long received = 0;
            long lastProgress = 0;
            try (InputStream input = connection.getInputStream();
                OutputStream output = new FileOutputStream(partial)) {
              byte[] buffer = new byte[65536];
              int count;
              while ((count = input.read(buffer)) != -1) {
                if (cancelled.get()) throw new IllegalStateException("Download cancelled.");
                output.write(buffer, 0, count);
                received += count;
                long now = System.currentTimeMillis();
                if (now - lastProgress > 150) {
                  notifyListeners(
                      "progress",
                      new JSObject()
                          .put("driveItemId", id)
                          .put("receivedBytes", received)
                          .put("totalBytes", Math.max(0, total)));
                  lastProgress = now;
                }
              }
            }
            if (cancelled.get()) throw new IllegalStateException("Download cancelled.");
            if (total >= 0 && total != received)
              throw new IllegalStateException("The download was incomplete.");
            File previous = stored(id);
            synchronized (OneDropDownloadPlugin.this) {
            if (cancelled.get()) throw new IllegalStateException("Download cancelled.");
            File file = new File(folder, name);
            if (!partial.renameTo(file))
              throw new IllegalStateException("The download could not be saved.");
            if (!getContext()
                .getSharedPreferences("downloads", Context.MODE_PRIVATE)
                .edit()
                .putString(id, name)
                .commit()) {
              throw new IllegalStateException("The download could not be saved.");
            }
            if (previous != null && !previous.equals(file)) previous.delete();
            }
            notifyListeners(
                "progress",
                new JSObject()
                    .put("driveItemId", id)
                    .put("receivedBytes", received)
                    .put("totalBytes", received));
            call.resolve(new JSObject().put("fileName", name));
          } catch (Exception error) {
            call.reject(error.getMessage(), error);
          } finally {
            if (partial != null) partial.delete();
            if (connection != null) connection.disconnect();
            downloads.remove(id, cancelled);
          }
        });
  }

  @PluginMethod
  public synchronized void removeAccount(PluginCall call) {
    try {
      String scope = required(call, "scope");
      if (!scope.matches("[0-9a-f]{64}")) throw new IllegalArgumentException();
      String prefix = scope + ":";
      for (Map.Entry<String, AtomicBoolean> task : downloads.entrySet()) if (task.getKey().startsWith(prefix)) task.getValue().set(true);
      android.content.SharedPreferences registry = getContext().getSharedPreferences("downloads", Context.MODE_PRIVATE);
      android.content.SharedPreferences.Editor edit = registry.edit();
      for (String id : registry.getAll().keySet()) if (id.startsWith(prefix)) {
        File folder = directory(id);
        File[] files = folder.listFiles();
        if (files != null) for (File file : files) if (!file.delete()) throw new IllegalStateException();
        if (folder.exists() && !folder.delete()) throw new IllegalStateException();
        edit.remove(id);
      }
      if (!edit.commit()) throw new IllegalStateException();
      call.resolve();
    } catch (Exception error) { call.reject("Account downloads could not be removed."); }
  }

  @PluginMethod
  public void cancel(PluginCall call) {
    AtomicBoolean cancelled = downloads.get(call.getString("driveItemId", ""));
    if (cancelled != null) cancelled.set(true);
    call.resolve();
  }

  @PluginMethod
  public void status(PluginCall call) {
    try {
      String id = required(call, "driveItemId");
      File file = stored(id);
      JSObject result =
          new JSObject().put("exists", file != null).put("downloading", downloads.containsKey(id));
      if (file != null) result.put("fileName", file.getName());
      call.resolve(result);
    } catch (Exception error) {
      call.reject(error.getMessage(), error);
    }
  }

  private File requireFile(PluginCall call) throws Exception {
    File file = stored(required(call, "driveItemId"));
    if (file == null)
      throw new IllegalStateException("The local file no longer exists. Please download it again.");
    return file;
  }

  private Uri fileUri(File file) {
    return FileProvider.getUriForFile(
        getContext(), getContext().getPackageName() + ".fileprovider", file);
  }

  static String fileExtension(String filename) {
    int dot = filename.lastIndexOf('.');
    return dot < 0 ? "" : filename.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
  }

  private String mimeType(File file) {
    String extension = fileExtension(file.getName());
    String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
    return type == null ? "application/octet-stream" : type;
  }

  @PluginMethod
  public void open(PluginCall call) {
    try {
      File file = requireFile(call);
      Intent intent =
          new Intent(Intent.ACTION_VIEW)
              .setDataAndType(fileUri(file), mimeType(file))
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      getActivity().startActivity(Intent.createChooser(intent, "Open with"));
      call.resolve(new JSObject().put("fileName", file.getName()));
    } catch (Exception error) {
      call.reject("Android could not open this file.", error);
    }
  }

  @PluginMethod
  public void showInFolder(PluginCall call) {
    try {
      File file = requireFile(call);
      Uri uri = fileUri(file);
      Intent intent =
          new Intent(Intent.ACTION_SEND)
              .setType(mimeType(file))
              .putExtra(Intent.EXTRA_STREAM, uri)
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      intent.setClipData(ClipData.newRawUri(file.getName(), uri));
      getActivity().startActivity(Intent.createChooser(intent, "Share file"));
      call.resolve(new JSObject().put("fileName", file.getName()));
    } catch (Exception error) {
      call.reject("Android could not share this file.", error);
    }
  }

  private File localExportFile(PluginCall call) {
    String id = required(call, "exportId");
    if (!id.matches("[0-9a-f-]{36}")) throw new IllegalArgumentException("Invalid local export.");
    return new File(getContext().getCacheDir(), "onedrop-exports/" + id + "/" + safeName(required(call, "fileName")));
  }

  @PluginMethod
  public void exportLocal(PluginCall call) {
    try {
      File file = localExportFile(call);
      Long offset = call.getLong("offset", -1L);
      String base64 = call.getString("base64");
      if (base64 == null || base64.length() > 710000 || offset < 0 || file.length() != offset)
        throw new IllegalArgumentException("Invalid local export chunk.");
      if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs())
        throw new IllegalStateException("Local export storage is unavailable.");
      try (FileOutputStream output = new FileOutputStream(file, offset != 0)) {
        output.write(Base64.decode(base64, Base64.DEFAULT));
      }
      if (!call.getBoolean("complete", false)) {
        call.resolve(new JSObject().put("fileName", file.getName()));
        return;
      }
      Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
          .addCategory(Intent.CATEGORY_OPENABLE).setType(mimeType(file))
          .putExtra(Intent.EXTRA_TITLE, file.getName());
      startActivityForResult(call, intent, "exportResult");
    } catch (Exception error) { call.reject("Android could not save this file.", error); }
  }

  @PluginMethod
  public void export(PluginCall call) {
    try {
      File file = requireFile(call);
      Intent intent =
          new Intent(Intent.ACTION_CREATE_DOCUMENT)
              .addCategory(Intent.CATEGORY_OPENABLE)
              .setType(mimeType(file))
              .putExtra(Intent.EXTRA_TITLE, file.getName());
      startActivityForResult(call, intent, "exportResult");
    } catch (Exception error) {
      call.reject("Android could not save this file.", error);
    }
  }

  @ActivityCallback
  private void exportResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    if (result.getResultCode() != Activity.RESULT_OK
        || result.getData() == null
        || result.getData().getData() == null) {
      call.reject("Saving was cancelled.");
      return;
    }
    Uri destination = result.getData().getData();
    executor.execute(
        () -> {
          try {
            File file = call.getString("exportId") == null ? requireFile(call) : localExportFile(call);
            String fileName = file.getName();
            try (InputStream input = new FileInputStream(file);
                OutputStream output =
                    getContext().getContentResolver().openOutputStream(destination, "wt")) {
              if (output == null)
                throw new IllegalStateException("The selected destination is unavailable.");
              byte[] buffer = new byte[65536];
              int count;
              while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            call.resolve(new JSObject().put("fileName", fileName));
          } catch (Exception error) {
            call.reject("Android could not save this file.", error);
          }
        });
  }

  @PluginMethod
  public void openExternal(PluginCall call) {
    try {
      Uri uri = Uri.parse(required(call, "url"));
      if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) {
        throw new IllegalArgumentException("An HTTP or HTTPS URL is required.");
      }
      getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri));
      call.resolve();
    } catch (Exception error) {
      call.reject("Android could not open this link.", error);
    }
  }

  @PluginMethod
  public void copyText(PluginCall call) {
    ClipboardManager clipboard =
        (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    clipboard.setPrimaryClip(ClipData.newPlainText("OneDrop", call.getString("text", "")));
    call.resolve();
  }

  @PluginMethod
  public void copyImage(PluginCall call) {
    try {
      String data = required(call, "dataUrl");
      if (data.length() > 40_000_000
          || !data.startsWith("data:image/")
          || !data.contains(";base64,")) {
        throw new IllegalArgumentException("The image could not be copied.");
      }
      byte[] bytes = Base64.decode(data.substring(data.indexOf(',') + 1), Base64.DEFAULT);
      android.graphics.BitmapFactory.Options bounds = new android.graphics.BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
      if (bounds.outWidth <= 0
          || bounds.outHeight <= 0
          || (long) bounds.outWidth * bounds.outHeight > 25_000_000) {
        throw new IllegalArgumentException("The image is too large to copy.");
      }
      android.graphics.Bitmap bitmap =
          android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
      if (bitmap == null) throw new IllegalArgumentException("The image could not be decoded.");
      File directory = new File(getContext().getCacheDir(), "clipboard");
      directory.mkdirs();
      File file = new File(directory, "image.png");
      try (OutputStream output = new FileOutputStream(file)) {
        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
      }
      bitmap.recycle();
      ClipboardManager clipboard =
          (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
      clipboard.setPrimaryClip(
          ClipData.newUri(getContext().getContentResolver(), "OneDrop image", fileUri(file)));
      call.resolve();
    } catch (Exception error) {
      call.reject("Android could not copy this image.", error);
    }
  }

  @Override
  protected void handleOnResume() {
    notifyListeners("resume", new JSObject());
  }
}
