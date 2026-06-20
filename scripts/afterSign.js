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

  // Apple code signing is skipped — POUNDING is a community fork.
  // The ad-hoc signed app runs fine; users right-click → Open first time.
  console.log('App signed with ad-hoc identity — ready for distribution');
};
