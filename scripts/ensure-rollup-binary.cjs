const { execSync } = require('child_process');

function ensureRollupBinary() {
  const platform = process.platform;
  const arch = process.arch;

  let targetPkg = null;
  if (platform === 'linux' && arch === 'x64') {
    targetPkg = '@rollup/rollup-linux-x64-gnu';
  } else if (platform === 'win32' && arch === 'x64') {
    targetPkg = '@rollup/rollup-win32-x64-msvc';
  } else if (platform === 'darwin' && arch === 'arm64') {
    targetPkg = '@rollup/rollup-darwin-arm64';
  } else if (platform === 'darwin' && arch === 'x64') {
    targetPkg = '@rollup/rollup-darwin-x64';
  }

  if (!targetPkg) return;

  try {
    require.resolve(targetPkg);
  } catch (err) {
    if (process.env.npm_lifecycle_event === 'postinstall') {
      console.log(`[ensure-rollup-binary] Note: ${targetPkg} not present. optionalDependencies will handle platform installation.`);
      return;
    }
    console.log(`[ensure-rollup-binary] Native Rollup package "${targetPkg}" missing for ${platform}-${arch}. Auto-installing...`);
    try {
      execSync(`npm install --no-save ${targetPkg}@4.63.1`, { stdio: 'inherit' });
      console.log(`[ensure-rollup-binary] Successfully installed ${targetPkg}`);
    } catch (e) {
      console.warn(`[ensure-rollup-binary] Warning: Could not install ${targetPkg}:`, e.message);
    }
  }
}

ensureRollupBinary();
