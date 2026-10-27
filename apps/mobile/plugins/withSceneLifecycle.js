// iOS 27's SDK refuses to launch apps without the UIScene life cycle ("UIScene life cycle is
// required for apps built with this SDK"). Expo 57 ships the scene delegate for it
// (ExpoAppSceneDelegate) but its project template still starts React Native from the app
// delegate. This plugin adopts the scene: Info.plist names Expo's delegate, and the app delegate
// only creates the React Native factory and hands it over (ExpoReactNativeFactoryProvider).
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const START_BLOCK =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;

function withSceneLifecycle(config) {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
          },
        ],
      },
    };
    return c;
  });
  return withAppDelegate(config, (c) => {
    if (c.modResults.language !== 'swift') throw new Error('withSceneLifecycle expects Swift');
    let src = c.modResults.contents;
    if (src.includes('ExpoReactNativeFactoryProvider')) return c;
    src = src.replace(
      'class AppDelegate: ExpoAppDelegate {',
      'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {',
    );
    if (!START_BLOCK.test(src)) throw new Error('withSceneLifecycle: AppDelegate template changed');
    // The scene delegate creates the window and starts React Native into it.
    src = src.replace(START_BLOCK, '\n');
    c.modResults.contents = src;
    return c;
  });
}

module.exports = withSceneLifecycle;
