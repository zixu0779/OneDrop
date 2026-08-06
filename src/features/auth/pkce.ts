function toBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function createRandomBase64Url(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function createPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = createRandomBase64Url(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );

  return {
    verifier,
    challenge: toBase64Url(new Uint8Array(digest)),
  };
}
