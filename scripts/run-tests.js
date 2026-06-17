const path = require('path');
const { runTests } = require('@vscode/test-electron');

// Some environments (e.g. shells launched by other Electron tools) export
// ELECTRON_RUN_AS_NODE=1. When set, the VS Code test Electron binary runs as
// plain Node and rejects its own launch flags (`bad option: --no-sandbox`),
// causing the test runner to exit with code 9. Strip it so the extension host
// can boot regardless of the ambient environment.
delete process.env.ELECTRON_RUN_AS_NODE;

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, '..', 'out', 'test', 'suite', 'index');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
