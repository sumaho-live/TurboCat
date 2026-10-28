import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { DebugAttacher } from '../../services/DebugAttacher';
import { Logger } from '../../services/Logger';

describe('DebugAttacher Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let attacher: DebugAttacher;
  let startDebugging: sinon.SinonStub;
  let autoAttach: boolean;
  let startListener: ((session: vscode.DebugSession) => void) | undefined;
  const folder = {
    uri: vscode.Uri.file('/tmp/turbocat-attach'),
    name: 'shop',
    index: 0
  } as vscode.WorkspaceFolder;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    Logger.clearInstancesForTests();
    autoAttach = true;
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, fallback?: unknown) => key === 'debugAutoAttach' ? autoAttach : fallback
    } as unknown as vscode.WorkspaceConfiguration);
    sandbox.stub(vscode.extensions, 'getExtension').returns({} as vscode.Extension<unknown>);
    sandbox.stub(vscode.debug, 'onDidStartDebugSession').callsFake(listener => {
      startListener = listener as (session: vscode.DebugSession) => void;
      return { dispose: () => undefined };
    });
    sandbox.stub(vscode.debug, 'onDidTerminateDebugSession').returns({ dispose: () => undefined });
    startDebugging = sandbox.stub(vscode.debug, 'startDebugging').resolves(true);
    attacher = new DebugAttacher();
  });

  afterEach(() => {
    attacher.dispose();
    sandbox.restore();
    Logger.clearInstancesForTests();
  });

  it('attaches a Java debugger to the given port', async () => {
    assert.strictEqual(await attacher.attach(folder, 8123), true);

    assert.strictEqual(startDebugging.callCount, 1);
    const [targetFolder, configuration] = startDebugging.firstCall.args;
    assert.strictEqual(targetFolder, folder);
    assert.deepStrictEqual(configuration, {
      type: 'java',
      name: 'TurboCat: shop',
      request: 'attach',
      hostName: 'localhost',
      port: 8123
    });
  });

  it('does nothing when turbocat.debugAutoAttach is false', async () => {
    autoAttach = false;

    assert.strictEqual(await attacher.attach(folder, 8123), false);
    assert.strictEqual(startDebugging.callCount, 0);
  });

  it('skips a port that already has a Java attach session', async () => {
    startListener?.({
      type: 'java',
      configuration: { type: 'java', request: 'attach', name: 'Attach', port: 8123 }
    } as unknown as vscode.DebugSession);

    assert.strictEqual(await attacher.attach(folder, 8123), true);
    assert.strictEqual(startDebugging.callCount, 0);

    await attacher.attach(folder, 8124);
    assert.strictEqual(startDebugging.callCount, 1);
  });

  it('does not attach when the Java debugger extension is missing', async () => {
    (vscode.extensions.getExtension as sinon.SinonStub).returns(undefined);

    assert.strictEqual(await attacher.attach(folder, 8123), false);
    assert.strictEqual(startDebugging.callCount, 0);
  });
});
