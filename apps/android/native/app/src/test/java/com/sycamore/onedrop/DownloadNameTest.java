package com.sycamore.onedrop;

import static org.junit.Assert.*;

import org.junit.Test;

public class DownloadNameTest {
  @Test
  public void confinesUntrustedNamesToOneFilename() {
    assertEquals(".._.._file.txt", OneDropDownloadPlugin.safeName("../../file.txt"));
    assertEquals("download", OneDropDownloadPlugin.safeName(".."));
    assertEquals(".partial", OneDropDownloadPlugin.safeName(".partial"));
    assertEquals("a_b_c.txt", OneDropDownloadPlugin.safeName("a\\b:c.txt"));
    assertEquals("photo.png", OneDropDownloadPlugin.safeName("photo.png"));
  }

  @Test
  public void detectsExtensionsInHumanFilenames() {
    assertEquals("pdf", OneDropDownloadPlugin.fileExtension("My report.PDF"));
    assertEquals("png", OneDropDownloadPlugin.fileExtension("截图 (1).png"));
    assertEquals("", OneDropDownloadPlugin.fileExtension("pdf"));
    assertEquals("", OneDropDownloadPlugin.fileExtension("file."));
  }
}
