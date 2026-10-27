declare const __KOVAN_SERVER_URL__: string | undefined;
declare const __KOVAN_UPDATE_PUBLIC_KEY__: string | undefined;

/** The server a release build talks to, set when it was built (KOVAN_BUILD_SERVER_URL). */
export const BUILT_SERVER_URL: string =
  typeof __KOVAN_SERVER_URL__ === 'string' ? __KOVAN_SERVER_URL__ : '';

/**
 * The public half of the update key (Ed25519, base64 SPKI), set when the app was built
 * (KOVAN_UPDATE_PUBLIC_KEY). Linux builds only install updates signed with the private half.
 */
export const UPDATE_PUBLIC_KEY: string =
  typeof __KOVAN_UPDATE_PUBLIC_KEY__ === 'string' ? __KOVAN_UPDATE_PUBLIC_KEY__ : '';
