// Packaging for the three platforms. Signing material comes from the environment and is never
// in the repo:
//   macOS    CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application), and for notarization
//            APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (or APPLE_ID +
//            APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)
//   Windows  AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET with the three
//            KOVAN_AZURE_* names below (Azure Trusted Signing), or WIN_CSC_LINK +
//            WIN_CSC_KEY_PASSWORD
//   Linux    AppImages carry no OS signature; updates are checked against the update key
//            instead (scripts/sign-update.mjs, KOVAN_UPDATE_PUBLIC_KEY at build time).
// Without them the build still works: macOS gets an ad-hoc signature (runs on this machine,
// can't be distributed or self-update), Windows and Linux are unsigned.
const env = process.env;
const macSigned = Boolean(env.CSC_LINK || env.CSC_NAME);
const notarize = Boolean(env.APPLE_API_KEY || env.APPLE_APP_SPECIFIC_PASSWORD);
const azure = env.KOVAN_AZURE_ENDPOINT && env.KOVAN_AZURE_ACCOUNT && env.KOVAN_AZURE_PROFILE;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.alperkayan.kovan.desktop',
  productName: 'Kovan',
  copyright: 'Copyright © Kovan',
  directories: { output: 'release', buildResources: 'build' },
  files: ['out/**', 'package.json', '!**/*.map'],
  // Native code and its helper binary must be real files on disk.
  asarUnpack: ['**/node_modules/node-pty/**'],
  // The MCP server and the hook script run as their own processes (Electron's Node), so they
  // live outside the archive. The package.json marks them as ES modules.
  extraResources: [
    { from: '../../packages/mcp-coordination/dist', to: 'mcp/dist', filter: ['**/*.js'] },
    { from: 'build/mcp-package.json', to: 'mcp/package.json' },
  ],
  // node-pty ships prebuilt binaries for macOS and Windows; Linux compiles it for Electron.
  npmRebuild: process.platform === 'linux',
  afterPack: './scripts/after-pack.cjs',
  electronFuses: {
    // The MCP server and hooks run through ELECTRON_RUN_AS_NODE, so that fuse stays on.
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // The app's page is loaded from the archive over file://, which needs this one.
    grantFileProtocolExtraPrivileges: true,
    resetAdHocDarwinSignature: !macSigned,
  },
  publish: [
    { provider: 'generic', url: env.KOVAN_UPDATE_URL || 'https://kovan.alperkayan.dev/updates' },
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    artifactName: 'Kovan-mac-${arch}.${ext}',
    minimumSystemVersion: '13.0',
    // The hardened runtime needs a real identity; an ad-hoc build would fail library validation.
    hardenedRuntime: macSigned,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    ...(macSigned ? {} : { identity: '-' }),
    notarize,
  },
  dmg: { sign: false },
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    artifactName: 'Kovan-win-${arch}.${ext}',
    ...(azure
      ? {
          azureSignOptions: {
            endpoint: env.KOVAN_AZURE_ENDPOINT,
            codeSigningAccountName: env.KOVAN_AZURE_ACCOUNT,
            certificateProfileName: env.KOVAN_AZURE_PROFILE,
          },
        }
      : {}),
  },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },
  linux: {
    // The package's own name (@kovan/desktop) can't be a file name.
    executableName: 'kovan',
    target: [{ target: 'AppImage', arch: ['x64'] }],
    artifactName: 'Kovan-linux-${arch}.${ext}',
    category: 'Development',
    synopsis: 'Multiplayer AI coding',
  },
};
