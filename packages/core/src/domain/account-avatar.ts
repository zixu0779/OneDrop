import { z } from "zod";

export function isAvatarImageHeader(mime: string, bytes: Uint8Array): boolean {
  if (mime === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/png")
    return [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    );
  return (
    mime === "image/webp" &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  );
}

export const avatarDataUrlSchema = z
  .string()
  .max(128 * 1024)
  .regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/u)
  .refine((value) => {
    try {
      const [header, data] = value.split(",");
      const bytes = Uint8Array.from(atob(data!), (char) => char.charCodeAt(0));
      return isAvatarImageHeader(header!.slice(5).split(";")[0]!, bytes);
    } catch {
      return false;
    }
  }, "Use a valid raster image.");
export const accountAvatarSchema = z.object({
  schemaVersion: z.literal(1),
  dataUrl: avatarDataUrlSchema.nullable(),
  updatedAt: z.iso.datetime(),
});
export type AccountAvatar = z.infer<typeof accountAvatarSchema>;
export function defaultAccountAvatar(): AccountAvatar {
  return {
    schemaVersion: 1,
    dataUrl: null,
    updatedAt: new Date(0).toISOString(),
  };
}
