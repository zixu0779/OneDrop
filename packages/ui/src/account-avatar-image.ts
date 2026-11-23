import {
  avatarDataUrlSchema,
  isAvatarImageHeader,
} from "@onedrop/core/domain/account-avatar";
export async function prepareAccountAvatar(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG or WebP image.");
  if (file.size > 5 * 1024 * 1024)
    throw new Error("Choose an image smaller than 5 MB.");
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (!isAvatarImageHeader(file.type, bytes))
    throw new Error("Choose a valid PNG, JPEG or WebP image.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error("This image could not be opened."));
      image.src = url;
    });
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth > 16384 ||
      image.naturalHeight > 16384
    )
      throw new Error("This image is too large to use as an avatar.");
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 256, 256);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
    return avatarDataUrlSchema.parse(canvas.toDataURL("image/jpeg", 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}
