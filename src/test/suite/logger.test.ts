import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { Logger } from '../../services/Logger';

describe('Logger Tests', () => {
  let logger: Logger;
  let sandbox: sinon.SinonSandbox;
  let lines: string[];

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    lines = [];
    (Logger as unknown as { instance?: Logger }).instance = undefined;
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
    logger.deactivate();
    sandbox.restore();
    (Logger as unknown as { instance?: Logger }).instance = undefined;
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
});
