package com.sycamore.onedrop;
import static org.junit.Assert.*;
import java.io.File;
import java.io.FileOutputStream;
import java.net.URL;
import org.junit.Test;
public class UpdateIntegrityTest {
 @Test public void rejectsNonOfficialMetadataAndUntrustedRedirects() throws Exception {
  String hash="a".repeat(64), url="https://github.com/zixu0779/OneDrop/releases/download/v1.2.0/OneDrop-1.2.0-android.apk";
  OneDropUpdatePlugin.validateMetadata("1.2.0",hash,url,100,"android","stable");
  for(String bad:new String[]{url.replace("zixu0779","other"),url+"?token=secret",url.replace("https:","http:")}){
   try {OneDropUpdatePlugin.validateMetadata("1.2.0",hash,bad,100,"android","stable");fail();}catch(SecurityException expected){}
  }
  assertTrue(OneDropUpdatePlugin.allowedDownloadUrl(new URL("https://release-assets.githubusercontent.com/example")));
  assertFalse(OneDropUpdatePlugin.allowedDownloadUrl(new URL("https://github.com.evil.test/file")));
  assertFalse(OneDropUpdatePlugin.allowedDownloadUrl(new URL("https://user:pass@github.com/file")));
  assertFalse(OneDropUpdatePlugin.allowedDownloadUrl(new URL("http://github.com/file")));
 }
 @Test public void requiresBothExactSizeAndHash() throws Exception {
  File file=File.createTempFile("update-integrity", ".apk");
  try(FileOutputStream stream=new FileOutputStream(file)){stream.write(new byte[]{97,98,99});}
  try {
   String hash="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
   assertTrue(OneDropUpdatePlugin.verifyFile(file,3,hash));
   assertFalse(OneDropUpdatePlugin.verifyFile(file,4,hash));
   assertFalse(OneDropUpdatePlugin.verifyFile(file,3,"0".repeat(64)));
  }finally{file.delete();}
 }
}
