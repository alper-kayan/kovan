// Expo ships its iOS modules precompiled, built with the Swift of the Xcode Expo used. A newer
// Xcode can't import them (Xcode 27's Swift 6.4 refuses ExpoModulesCore built with 6.3.1), so
// release archives fail. Building them from source works with any Xcode; it only makes a clean
// build slower.
const { withPodfileProperties } = require('expo/config-plugins');

function withModulesFromSource(config) {
  return withPodfileProperties(config, (c) => {
    c.modResults.EXPO_USE_PRECOMPILED_MODULES = 'false';
    return c;
  });
}

module.exports = withModulesFromSource;
