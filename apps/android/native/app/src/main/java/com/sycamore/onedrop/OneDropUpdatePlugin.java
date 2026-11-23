package com.sycamore.onedrop;

import android.content.Intent;
import android.content.ClipData;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;

@CapacitorPlugin(name = "OneDropUpdate")
public class OneDropUpdatePlugin extends Plugin {
  private boolean busy;

  @PluginMethod public synchronized void install(PluginCall call) {
    if (busy) { call.reject("An update is already in progress."); return; }
    busy=true;
    new Thread(() -> {
      try {
        String version=call.getString("version", ""), digest=call.getString("sha256", ""), url=call.getString("url", "");
        long size=metadataSize(call);
        validateMetadata(version,digest,url,size,call.getString("platform",""),call.getString("channel",""));
        File directory=new File(getContext().getCacheDir(),"updates");
        if(!directory.isDirectory() && !directory.mkdirs())throw new IOException();
        File apk=new File(directory,digest+".apk");
        if(!apk.isFile() || !verifyFile(apk,size,digest)) {
          File temporary=File.createTempFile("update-",".partial",directory);
          try { download(url,temporary,size,digest); if(!verifyFile(temporary,size,digest))throw new SecurityException("The update failed its integrity check. Try again."); if(apk.exists()&&!apk.delete())throw new IOException();if(!temporary.renameTo(apk))throw new IOException(); }
          finally { temporary.delete(); }
        }
        verifyPackage(apk,version);
        getActivity().runOnUiThread(() -> {
          try {
            if(Build.VERSION.SDK_INT>=26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
              Intent settings=new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getContext().getPackageName()));
              startActivityForResult(call,settings,"permissionResult");
              return;
            }
            Uri uri=FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".fileprovider",apk);
            Intent install=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            install.setClipData(ClipData.newRawUri("OneDrop update",uri));
            getActivity().startActivity(install);
            finish(call,"Installer opened. Confirm the update in Android. Your OneDrop data is kept.");
          } catch(Exception error) { fail(call,"The Android installer could not be opened. Try again."); }
        });
      }catch(Exception error){fail(call,error instanceof SecurityException?error.getMessage():"The update could not be downloaded or verified. Try again.");}
    },"OneDrop-update").start();
  }

  @ActivityCallback private void permissionResult(PluginCall call,ActivityResult result) {
    if(call==null){synchronized(this){busy=false;}return;}
    boolean allowed=Build.VERSION.SDK_INT<26 || getContext().getPackageManager().canRequestPackageInstalls();
    finish(call,allowed?"Permission granted. Tap Install again to open the Android installer.":"Installation permission was not granted. Tap Install to try again.");
  }
  private synchronized void finish(PluginCall call,String message){busy=false;call.resolve(new JSObject().put("message",message));}
  private synchronized void fail(PluginCall call,String message){busy=false;call.reject(message);}

  static long metadataSize(PluginCall call) { return call.getInt("size", 0); }
  static void validateMetadata(String version,String digest,String url,long size,String platform,String channel) {
    if(!"android".equals(platform)||!"stable".equals(channel)||!version.matches("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")||!digest.matches("[a-f0-9]{64}")||size<=0||size>256L*1024*1024||!url.equals("https://github.com/zixu0779/OneDrop/releases/download/v"+version+"/OneDrop-"+version+"-android.apk"))throw new SecurityException("Invalid official update information. Check for updates again.");
  }
  static boolean allowedDownloadUrl(URL url) {
    return "https".equals(url.getProtocol()) && url.getUserInfo()==null && (url.getPort()==-1||url.getPort()==443) && Arrays.asList("github.com","release-assets.githubusercontent.com","github-releases.githubusercontent.com").contains(url.getHost());
  }
  private void download(String value,File target,long expectedSize,String digest)throws Exception {
    URL url=new URL(value);
    for(int redirects=0;redirects<=5;redirects++) {
      if(!allowedDownloadUrl(url))throw new SecurityException("The update redirected to an untrusted server.");
      HttpURLConnection connection=(HttpURLConnection)url.openConnection();
      connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(20000);connection.setReadTimeout(20000);
      try {
        int status=connection.getResponseCode();
        if(status>=300&&status<400){String next=connection.getHeaderField("Location");if(next==null)throw new IOException();url=new URL(url,next);continue;}
        if(status!=200)throw new IOException();
        try(InputStream input=connection.getInputStream();OutputStream output=new FileOutputStream(target)){
          byte[] buffer=new byte[65536];long total=0,last=0;int count;
          while((count=input.read(buffer))!=-1){total+=count;if(total>expectedSize)throw new SecurityException("The update size does not match. Try again.");output.write(buffer,0,count);long now=System.currentTimeMillis();if(now-last>=200){last=now;notifyListeners("progress",new JSObject().put("sha256",digest).put("received",total).put("total",expectedSize));}}
          if(total!=expectedSize)throw new SecurityException("The update is incomplete. Try again.");
        }
        return;
      } finally {connection.disconnect();}
    }
    throw new IOException("Too many redirects");
  }
  static boolean verifyFile(File file,long size,String digest)throws Exception {
    if(file.length()!=size)return false;
    MessageDigest hash=MessageDigest.getInstance("SHA-256");
    try(InputStream input=new FileInputStream(file)){byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1)hash.update(buffer,0,count);}
    StringBuilder actual=new StringBuilder();for(byte b:hash.digest())actual.append(String.format(Locale.ROOT,"%02x",b));return actual.toString().equals(digest);
  }
  private void verifyPackage(File apk,String version)throws Exception {
    PackageManager pm=getContext().getPackageManager();int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
    PackageInfo next=pm.getPackageArchiveInfo(apk.getAbsolutePath(),flags), current=pm.getPackageInfo(getContext().getPackageName(),flags);
    validatePackage(next,current,version);
  }
  static void validatePackage(PackageInfo next,PackageInfo current,String version)throws Exception {
    if(next==null||!current.packageName.equals(next.packageName)||!version.equals(next.versionName)||versionCode(next)<=versionCode(current)||!signers(next).equals(signers(current)))throw new SecurityException("The APK does not match this app's identity, signature or newer version.");
  }
  private static long versionCode(PackageInfo info){return Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode;}
  private static Set<String> signers(PackageInfo info)throws Exception {
    Signature[] signatures=Build.VERSION.SDK_INT>=28?(info.signingInfo==null?null:info.signingInfo.getApkContentsSigners()):info.signatures;
    if(signatures==null||signatures.length==0)throw new SecurityException("The APK has no verified signing identity.");
    Set<String> result=new HashSet<>();for(Signature signature:signatures)result.add(android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()),android.util.Base64.NO_WRAP));return result;
  }
}
