import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { TomcatBase } from '../../services/TomcatBase';

describe('TomcatBase Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let workspaceRoot: string;
  let tomcatHome: string;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turbocat-workspace-base-test-'));
    tomcatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'turbocat-home-base-test-'));
    fs.mkdirSync(path.join(tomcatHome, 'conf'), { recursive: true });
    fs.writeFileSync(path.join(tomcatHome, 'conf', 'server.xml'), '<Server port="8005" />');
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{
      uri: vscode.Uri.file(workspaceRoot),
      name: path.basename(workspaceRoot),
      index: 0
    }]);
    (TomcatBase as unknown as { instance?: TomcatBase }).instance = undefined;
  });

  afterEach(() => {
    sandbox.restore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(tomcatHome, { recursive: true, force: true });
    (TomcatBase as unknown as { instance?: TomcatBase }).instance = undefined;
  });

  it('creates a workspace Catalina base with runtime folders and copied config', async () => {
    const catalinaBase = await TomcatBase.getInstance().resolveCatalinaBase(tomcatHome);

    assert.strictEqual(catalinaBase, path.join(workspaceRoot, '.vscode', 'turbocat'));
    for (const folder of ['conf', 'logs', 'temp', 'work', 'webapps']) {
      assert.strictEqual(fs.existsSync(path.join(catalinaBase, folder)), true);
    }
    assert.strictEqual(
      fs.readFileSync(path.join(catalinaBase, 'conf', 'server.xml'), 'utf8'),
      '<Server port="8005" />'
    );
  });

  it('preserves existing workspace config files', async () => {
    const existingConf = path.join(workspaceRoot, '.vscode', 'turbocat', 'conf');
    fs.mkdirSync(existingConf, { recursive: true });
    fs.writeFileSync(path.join(existingConf, 'server.xml'), '<Server port="9005" />');

    const catalinaBase = await TomcatBase.getInstance().resolveCatalinaBase(tomcatHome);

    assert.strictEqual(
      fs.readFileSync(path.join(catalinaBase, 'conf', 'server.xml'), 'utf8'),
      '<Server port="9005" />'
    );
  });
});
