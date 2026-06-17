import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({
    color: true,
    ui: 'bdd'
  });
  const testsRoot = __dirname;
  let testFiles = 0;

  for (const file of fs.readdirSync(testsRoot)) {
    if (file.endsWith('.test.js')) {
      testFiles++;
      mocha.addFile(path.resolve(testsRoot, file));
    }
  }

  if (testFiles === 0) {
    return Promise.reject(new Error(`No test files found in ${testsRoot}`));
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed`));
      } else {
        resolve();
      }
    });
  });
}
