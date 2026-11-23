package com.sycamore.onedrop;
import static org.junit.Assert.*;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
public class UpdatePackageTest {
 @Test public void readsJavascriptIntegerSizeFromCapacitorCall()throws Exception {
  com.getcapacitor.JSObject data=new com.getcapacitor.JSObject("{\"size\":4005851}");
  com.getcapacitor.PluginCall call=new com.getcapacitor.PluginCall(null,"OneDropUpdate","test","install",data);
  assertEquals(4005851L,OneDropUpdatePlugin.metadataSize(call));
 }
 @Test public void requiresNewerVersionSamePackageAndInstalledSigningIdentity()throws Exception {
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();PackageManager pm=context.getPackageManager();
  PackageInfo current=pm.getPackageInfo(context.getPackageName(),PackageManager.GET_SIGNING_CERTIFICATES);
  android.os.Parcel parcel=android.os.Parcel.obtain();current.writeToParcel(parcel,0);parcel.setDataPosition(0);PackageInfo next=PackageInfo.CREATOR.createFromParcel(parcel);parcel.recycle();
  try{OneDropUpdatePlugin.validatePackage(next,current,current.versionName);fail();}catch(SecurityException expected){}
  next.setLongVersionCode(current.getLongVersionCode()+1);next.versionName="9.0.0";
  OneDropUpdatePlugin.validatePackage(next,current,"9.0.0");
  try{OneDropUpdatePlugin.validatePackage(next,current,"9.0.1");fail();}catch(SecurityException expected){}
  next.packageName="unrelated.application";
  try{OneDropUpdatePlugin.validatePackage(next,current,"9.0.0");fail();}catch(SecurityException expected){}
  next.packageName=current.packageName;
  next.signingInfo=pm.getPackageInfo("android",PackageManager.GET_SIGNING_CERTIFICATES).signingInfo;
  try{OneDropUpdatePlugin.validatePackage(next,current,"9.0.0");fail();}catch(SecurityException expected){}
 }
}
