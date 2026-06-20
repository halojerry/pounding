const { execSync } = require('child_process');

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  // Check if app is properly signed
  try {
    execSync(`codesign --verify --verbose "${appPath}"`, { stdio: 'pipe' });
    console.log(`App ${appName} is properly code signed`);
  } catch {
    // Apply ad-hoc signature (allows app to run locally, user just needs
    // to right-click → Open on first launch to bypass Gatekeeper).
    console.log(`App ${appName} is not code signed, applying ad-hoc signature...`);
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log(`Ad-hoc signature applied successfully to ${appName}`);
  }

  // Notarization is skipped — POUNDING is a community fork without an
  // Apple Developer Program membership. The ad-hoc signed app works
  // perfectly; users just right-click → Open the first time.
  console.log('Skipping notarization (no Apple Developer account for this fork)');
};
