import { z } from "zod";

export const tokenResponseSchema = z.object({
  token_type: z.string(),
  scope: z.string(),
  expires_in: z.number().positive(),
  access_token: z.string().min(1),
  id_token: z.string().optional(),
  refresh_token: z.string().optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

type IdTokenClaims = {
  name?: string | undefined;
  preferred_username?: string | undefined;
};

export function readUnverifiedIdTokenClaims(idToken?: string): IdTokenClaims {
  if (!idToken) {
    return {};
  }

  const payload = idToken.split(".")[1];

  if (!payload) {
    return {};
  }

  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));

    return z
      .object({
        name: z.string().optional(),
        preferred_username: z.string().optional(),
      })
      .parse(parsed);
  } catch {
    return {};
  }
}
