import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { JavaReadiness } from '../../services/JavaReadiness';

describe('JavaReadiness', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    JavaReadiness.resetForTests();
  });

  afterEach(() => {
    sandbox.restore();
    JavaReadiness.resetForTests();
  });

  const stubJavaExtension = (exports: unknown, isActive = true) =>
    sandbox.stub(vscode.extensions, 'getExtension').returns({
      isActive,
      exports,
      activate: async () => exports
    } as unknown as vscode.Extension<unknown>);

  it('is ready immediately when the Java extension is not installed', async () => {
    sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);
    assert.strictEqual(JavaReadiness.isReady(), true);
    assert.strictEqual(await JavaReadiness.whenReady(), true);
  });

  it('waits for serverReady() before reporting ready', async () => {
    let release!: () => void;
    const serverReady = new Promise<boolean>(resolve => { release = () => resolve(true); });
    stubJavaExtension({ serverReady: () => serverReady }, false);

    assert.strictEqual(JavaReadiness.isReady(), false);
    const pending = JavaReadiness.whenReady();
    release();
    assert.strictEqual(await pending, true);
    assert.strictEqual(JavaReadiness.isReady(), true);
  });

  it('falls back to the status field on older Java extension APIs', async () => {
    const api = { status: 'Starting' };
    stubJavaExtension(api);
    const clock = sandbox.useFakeTimers();
    const pending = JavaReadiness.whenReady();
    api.status = 'Started';
    await clock.tickAsync(1500);
    assert.strictEqual(await pending, true);
  });

  it('reports not ready when the Java server errors, and allows a retry', async () => {
    stubJavaExtension({ status: 'Error' });
    assert.strictEqual(await JavaReadiness.whenReady(), false);
    assert.strictEqual(JavaReadiness.isReady(), false);
  });
});
