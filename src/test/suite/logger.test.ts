import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import iconv from 'iconv-lite';
import { Logger } from '../../services/Logger';

describe('Logger Tests', () => {
  let logger: Logger;
  let sandbox: sinon.SinonSandbox;
  let lines: string[];

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    lines = [];
    Logger.clearInstancesForTests();
    sandbox.stub(vscode.window, 'createOutputChannel').returns({
      name: 'TurboCat',
      logLevel: vscode.LogLevel.Info,
      onDidChangeLogLevel: () => ({ dispose: () => undefined }),
      appendLine: (line: string) => lines.push(line),
      append: (value: string) => lines.push(value),
      replace: () => undefined,
      clear: () => { lines = []; },
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined
    } as unknown as vscode.LogOutputChannel);
    logger = Logger.getInstance();
  });

  afterEach(() => {
    Logger.clearInstancesForTests();
    sandbox.restore();
  });

  it('formats extension logs with TurboCat prefix', () => {
    logger.info('hello');

    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /\[TurboCat\]\[INFO\] hello$/);
  });

  it('passes raw Tomcat log lines through unchanged', () => {
    logger.appendRawLine('GET /health 200');

    assert.deepStrictEqual(lines, ['GET /health 200']);
  });

  it('hides smart deploy chatter but keeps warnings when showSmartDeployLog is off', () => {
    (logger as unknown as { showSmartDeployLog: boolean }).showSmartDeployLog = false;

    logger.info('copied', false, 'smartDeploy');
    logger.warn('copy failed', false, 'smartDeploy');
    logger.info('general');

    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /\[WARN\] copy failed$/);
    assert.match(lines[1], /\[INFO\] general$/);
  });

  it('reveals the output panel once per run for Tomcat output', () => {
    const shown = sandbox.spy();
    (logger as unknown as { outputChannel: { show: () => void } }).outputChannel.show = shown;

    logger.appendRawLine('line 1');
    logger.appendRawLine('line 2');
    assert.strictEqual(shown.callCount, 1);

    logger.resetOutputReveal();
    logger.appendRawLine('line 3');
    assert.strictEqual(shown.callCount, 2);
  });

  it('decodes multi-byte characters split across log chunks', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'turbocat-logger-'));
    const logPath = path.join(dir, 'localhost_access_log.2026-01-01.log');
    const internals = logger as unknown as {
      logEncoding: string;
      accessLogOffsets: Map<string, number>;
      handleLiveLogUpdate: (file: string) => Promise<void>;
    };
    try {
      internals.logEncoding = 'gbk';
      await fsp.writeFile(logPath, '');
      internals.accessLogOffsets.set(logPath, 0);

      const bytes = iconv.encode('访问日志\n', 'gbk');
      await fsp.appendFile(logPath, bytes.subarray(0, 3));
      const first = internals.handleLiveLogUpdate(logPath);
      await fsp.appendFile(logPath, bytes.subarray(3));
      // Queued behind the first read even though it is not awaited yet
      const second = internals.handleLiveLogUpdate(logPath);
      await Promise.all([first, second]);

      assert.deepStrictEqual(lines, ['访问日志']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads a rotated access log from its first line and keeps the cursor on re-attach', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'turbocat-logger-'));
    const logPath = path.join(base, 'logs', 'localhost_access_log.2026-01-02.log');
    const internals = logger as unknown as {
      watchAccessLogDirectly: (home: string, fromStart?: boolean) => Promise<void>;
      tailQueues: Map<string, Promise<void>>;
      accessLogOffsets: Map<string, number>;
    };
    try {
      await fsp.mkdir(path.dirname(logPath));
      await fsp.writeFile(logPath, 'GET /first 200\n');

      await internals.watchAccessLogDirectly(base, true);
      await internals.tailQueues.get(logPath);
      assert.deepStrictEqual(lines, ['GET /first 200']);

      // A later rename event for the same file must not rewind or skip
      await internals.watchAccessLogDirectly(base, true);
      await internals.tailQueues.get(logPath);
      assert.deepStrictEqual(lines, ['GET /first 200']);
      assert.strictEqual(internals.accessLogOffsets.get(logPath), 15);
    } finally {
      logger.releaseRuntime();
      await fsp.rm(base, { recursive: true, force: true });
    }
  });
});
