const PAIRING_TOKEN_PARAM = "token";

function readHashParams(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
}

export function getPairingTokenFromUrl(url: URL): string | null {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
}

export function stripPairingTokenFromUrl(url: URL): URL {
  const next = new URL(url.toString());
  const hashParams = readHashParams(next);
  if (hashParams.has(PAIRING_TOKEN_PARAM)) {
    hashParams.delete(PAIRING_TOKEN_PARAM);
    next.hash = hashParams.toString();
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
}

export function setPairingTokenOnUrl(url: URL, credential: string): URL {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
}

export function parsePairingCredential(value: string, origin: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Enter a pairing token or a pairing link.");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    if (/\s/.test(trimmed) || trimmed.includes("://") || trimmed.startsWith("/")) {
      throw new Error("Enter a token or a complete http(s) pairing link.");
    }
    return trimmed;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("This pairing link is not a valid URL.");
  }
  if (url.origin !== origin || url.username || url.password) {
    throw new Error(
      "This pairing link belongs to a different environment. Open that link instead.",
    );
  }
  const token = getPairingTokenFromUrl(url);
  if (url.pathname !== "/pair" || !token) {
    throw new Error("This pairing link must use the /pair path and contain a one-time token.");
  }
  return token;
}
