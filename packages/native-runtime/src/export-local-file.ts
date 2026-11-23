import { legacyNativeDownload } from "./native-download";
export async function exportBlob(name: string, blob: Blob) {
  const exportId = crypto.randomUUID();
  const chunkSize = 512 * 1024;
  for (
    let offset = 0;
    offset < blob.size || offset === 0;
    offset += chunkSize
  ) {
    const chunk = blob.slice(offset, offset + chunkSize);
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () =>
        reject(new Error("The local file could not be read."));
      reader.readAsDataURL(chunk);
    });
    await legacyNativeDownload.exportLocal({
      fileName: name,
      base64,
      exportId,
      offset,
      complete: offset + chunkSize >= blob.size,
    });
  }
}
