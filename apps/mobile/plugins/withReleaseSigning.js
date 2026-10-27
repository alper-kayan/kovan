// Release builds are signed with our own upload key, not the template's debug key. The key and
// its passwords stay out of the project: gradle reads them from properties (~/.gradle/
// gradle.properties or -P flags). Without them a release build still signs with the debug key,
// which is fine on a test phone and refused by Play.
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_CONFIG = `
        release {
            if (findProperty('KOVAN_UPLOAD_STORE_FILE')) {
                storeFile file(findProperty('KOVAN_UPLOAD_STORE_FILE'))
                storePassword findProperty('KOVAN_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('KOVAN_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('KOVAN_UPLOAD_KEY_PASSWORD')
            }
        }`;

const DEBUG_CONFIG = /(signingConfigs \{\n\s*debug \{[\s\S]*?\n\s*\})/;
const RELEASE_SIGNING =
  /(release \{\n\s*\/\/ Caution![^\n]*\n\s*\/\/ see[^\n]*\n\s*)signingConfig signingConfigs\.debug/;

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    let src = c.modResults.contents;
    if (src.includes('KOVAN_UPLOAD_STORE_FILE')) return c;
    if (!DEBUG_CONFIG.test(src) || !RELEASE_SIGNING.test(src)) {
      throw new Error('withReleaseSigning: build.gradle template changed');
    }
    src = src.replace(DEBUG_CONFIG, `$1${RELEASE_CONFIG}`);
    src = src.replace(
      RELEASE_SIGNING,
      "$1signingConfig findProperty('KOVAN_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug",
    );
    c.modResults.contents = src;
    return c;
  });
}

module.exports = withReleaseSigning;
