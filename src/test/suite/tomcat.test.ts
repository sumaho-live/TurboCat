import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as net from 'net';
import * as vscode from 'vscode';
import { Tomcat } from '../../services/Tomcat';
import { Logger } from '../../services/Logger';

describe('Tomcat Tests', () => {
  let tomcat: Tomcat;
  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turbocat-tomcat-test-'));
    Tomcat.clearInstancesForTests();
    Logger.clearInstancesForTests();
    tomcat = Tomcat.getInstance();
  });

  afterEach(() => {
    sandbox.restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    Tomcat.clearInstancesForTests();
    Logger.clearInstancesForTests();
  });

  it('rejects ports outside the supported range', async () => {
    sandbox.stub(tomcat as unknown as { isPortListening(port: number): Promise<boolean> }, 'isPortListening').resolves(false);

    await assert.rejects(
      (tomcat as unknown as { validatePort(port: number): Promise<void> }).validatePort(1000),
      /Ports below 1024 require admin privileges/
    );

    await assert.rejects(
      (tomcat as unknown as { validatePort(port: number): Promise<void> }).validatePort(49152),
      /Maximum allowed port is 49151/
    );
  });

  it('normalizes configured application names', () => {
    tomcat.setAppName('/nested/app/');

    assert.strictEqual(tomcat.getAppName(), 'nested/app');
  });

  it('strips traversal segments from configured application names', () => {
    tomcat.setAppName('../outside/./app/');

    assert.strictEqual(tomcat.getAppName(), 'outside/app');
  });

  it('does not stop Tomcat when the extension deactivates', async () => {
    const stop = sandbox.stub(tomcat, 'stop').resolves(true);

    await tomcat.deactivate();

    assert.strictEqual(stop.called, false);
  });

  it('reports only the Tomcat process owned by the current project', async () => {
    const folder = {
      uri: vscode.Uri.file(tempRoot),
      name: path.basename(tempRoot),
      index: 0,
    };
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([folder]);
    const projectTomcat = Tomcat.getInstance(folder.uri);
    const internal = projectTomcat as unknown as {
      tomcatHome: string;
      processOwnership: {
        record(data: {
          pid: number;
          workspaceUri: string;
          catalinaHome: string;
          catalinaBase: string;
          httpPort: number;
          shutdownPort: number;
          mode: 'run' | 'debug';
        }): Promise<unknown>;
      };
      isPortListening(port: number): Promise<boolean>;
    };
    internal.tomcatHome = path.join(tempRoot, 'tomcat-home');
    sandbox.stub(projectTomcat, 'getCatalinaBase').resolves(tempRoot);
    const portCheck = sandbox.stub(internal, 'isPortListening').resolves(true);

    await internal.processOwnership.record({
      pid: process.pid,
      workspaceUri: 'file:///another-project',
      catalinaHome: internal.tomcatHome,
      catalinaBase: tempRoot,
      httpPort: 8080,
      shutdownPort: 8005,
      mode: 'run',
    });

    assert.strictEqual(await projectTomcat.isRunning(), false);
    assert.strictEqual(portCheck.called, false);

    await internal.processOwnership.record({
      pid: process.pid,
      workspaceUri: folder.uri.toString(),
      catalinaHome: internal.tomcatHome,
      catalinaBase: tempRoot,
      httpPort: 8080,
      shutdownPort: 8005,
      mode: 'run',
    });

    assert.strictEqual(await projectTomcat.isRunning(), true);
  });

  it('updates shutdown and HTTP ports in server.xml without touching AJP', async () => {
    const confDir = path.join(tempRoot, 'conf');
    fs.mkdirSync(confDir, { recursive: true });
    const serverXmlPath = path.join(confDir, 'server.xml');
    fs.writeFileSync(serverXmlPath, [
      '<Server port="8005" shutdown="SHUTDOWN">',
      '  <Service name="Catalina">',
      '    <Connector port="8009" protocol="AJP/1.3" />',
      '    <Connector port="8080" protocol="HTTP/1.1" />',
      '  </Service>',
      '</Server>'
    ].join('\n'));

    await (tomcat as unknown as {
      modifyServerXmlPorts(tomcatHome: string, ports: { http: number; shutdown: number }): Promise<void>;
    }).modifyServerXmlPorts(tempRoot, { http: 9090, shutdown: 9005 });

    const updated = fs.readFileSync(serverXmlPath, 'utf8');
    assert.match(updated, /<Server port="9005"/);
    assert.match(updated, /<Connector port="8009" protocol="AJP\/1\.3"/);
    assert.match(updated, /<Connector port="9090" protocol="HTTP\/1\.1"/);
  });

  describe('startup port checks', () => {
    type Internals = {
      port: number;
      shutdownPort: number;
      tomcatProcess: unknown;
      isPortListening(port: number): Promise<boolean>;
      isPortInUse(port: number): Promise<boolean>;
      waitForStartup(timeoutMs?: number): Promise<boolean>;
      resolveDebugPort(): Promise<number | undefined>;
      getConfiguration(): unknown;
    };
    const internals = () => tomcat as unknown as Internals;

    const listenOnFreePort = async (): Promise<net.Server> => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server;
    };

    it('detects a port bound by another process even when netstat finds nothing', async () => {
      sandbox.stub(internals(), 'isPortListening').resolves(false);
      const server = await listenOnFreePort();
      try {
        const port = (server.address() as net.AddressInfo).port;
        assert.strictEqual(await internals().isPortInUse(port), true);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('fails startup as soon as the Tomcat process exits', async () => {
      sandbox.stub(internals(), 'isPortListening').resolves(false);
      internals().tomcatProcess = { exitCode: 2, signalCode: null };

      const started = Date.now();
      assert.strictEqual(await internals().waitForStartup(5000), false);
      assert.ok(Date.now() - started < 1000);
    });

    it('does not treat a live process without listening ports as started', async () => {
      sandbox.stub(internals(), 'isPortListening').resolves(false);
      internals().tomcatProcess = { exitCode: null, signalCode: null };

      assert.strictEqual(await internals().waitForStartup(600), false);
    });

    it('reports started once the HTTP port listens', async () => {
      internals().port = 18080;
      sandbox.stub(internals(), 'isPortListening').callsFake(async (port: number) => port === 18080);
      internals().tomcatProcess = { exitCode: null, signalCode: null };

      assert.strictEqual(await internals().waitForStartup(1000), true);
    });

    it('offers a free debug port when the configured one is taken', async () => {
      const server = await listenOnFreePort();
      try {
        const busy = (server.address() as net.AddressInfo).port;
        const update = sandbox.stub().resolves();
        sandbox.stub(internals(), 'getConfiguration').returns({
          get: (key: string, fallback: unknown) => (key === 'debugPort' ? busy : fallback),
          update,
        });
        sandbox.stub(internals(), 'isPortListening').resolves(false);
        sandbox.stub(vscode.window, 'showWarningMessage').callsFake(
          (async (_message: string, ...items: string[]) => items[0]) as unknown as typeof vscode.window.showWarningMessage,
        );

        const chosen = await internals().resolveDebugPort();

        assert.ok(chosen && chosen > busy);
        assert.ok(update.calledWith('debugPort', chosen));
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('lifecycle serialization', () => {
    type Impl = {
      startDebugServer(show: boolean): Promise<boolean>;
      stopServer(show: boolean): Promise<boolean>;
      startServer(show: boolean): Promise<boolean>;
    };

    it('joins a debug start that is already in progress instead of launching a second JVM', async () => {
      let finish!: (value: boolean) => void;
      const impl = sandbox.stub(tomcat as unknown as Impl, 'startDebugServer').returns(
        new Promise<boolean>((resolve) => { finish = resolve; }),
      );

      const first = tomcat.startDebug(false);
      const second = tomcat.startDebug(false);
      await new Promise((resolve) => setImmediate(resolve));
      finish(true);

      assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
      assert.strictEqual(impl.callCount, 1);
    });

    it('runs different lifecycle requests one after another', async () => {
      const order: string[] = [];
      let finishStop!: (value: boolean) => void;
      sandbox.stub(tomcat as unknown as Impl, 'stopServer').callsFake(() => {
        order.push('stop:begin');
        return new Promise<boolean>((resolve) => { finishStop = resolve; });
      });
      sandbox.stub(tomcat as unknown as Impl, 'startServer').callsFake(async () => {
        order.push('start');
        return true;
      });

      const stopped = tomcat.stop(false);
      const started = tomcat.start(false);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(order, ['stop:begin']);

      order.push('stop:end');
      finishStop(true);
      await Promise.all([stopped, started]);

      assert.deepStrictEqual(order, ['stop:begin', 'stop:end', 'start']);
    });

    it('keeps the queue usable after a failed request', async () => {
      sandbox.stub(tomcat as unknown as Impl, 'stopServer').rejects(new Error('boom'));
      sandbox.stub(tomcat as unknown as Impl, 'startServer').resolves(true);

      await assert.rejects(tomcat.stop(false), /boom/);
      assert.strictEqual(await tomcat.start(false), true);
    });
  });

  describe('debug start notification', () => {
    const stubDebugStart = (): void => {
      const internals = tomcat as unknown as Record<string, unknown>;
      sandbox.stub(internals, 'findTomcatHome' as never).resolves(tempRoot as never);
      sandbox.stub(internals, 'findJavaHome' as never).resolves(tempRoot as never);
      sandbox.stub(internals, 'getCatalinaBase' as never).resolves(tempRoot as never);
      sandbox.stub(internals, 'ensureTomcatStopped' as never).resolves(true as never);
      sandbox.stub(internals, 'applyPortChange' as never).resolves(undefined as never);
      sandbox.stub(internals, 'syncServerXmlPorts' as never).resolves(undefined as never);
      sandbox.stub(internals, 'ensureServerPortsFree' as never).resolves(true as never);
      sandbox.stub(internals, 'resolveDebugPort' as never).resolves(8123 as never);
      sandbox.stub(internals, 'executeTomcatCommand' as never).resolves(undefined as never);
      sandbox.stub(internals, 'waitForStartup' as never).resolves(true as never);
      sandbox.stub(internals, 'isTomcatRunning' as never).resolves(false as never);
    };

    it('announces the JDWP port after the Debug button starts Tomcat', async () => {
      stubDebugStart();
      const ports: number[] = [];
      const listener = Tomcat.onDidStartDebug(event => ports.push(event.port));
      try {
        assert.strictEqual(await tomcat.startDebug(false), true);
      } finally {
        listener.dispose();
      }
      assert.deepStrictEqual(ports, [8123]);
    });

    it('stays silent when a debugger attach profile starts Tomcat', async () => {
      stubDebugStart();
      const ports: number[] = [];
      const listener = Tomcat.onDidStartDebug(event => ports.push(event.port));
      try {
        assert.strictEqual(await tomcat.ensureDebugModeActive(false), true);
      } finally {
        listener.dispose();
      }
      assert.deepStrictEqual(ports, []);
    });
  });

  it('writes the configured ports into a stale server.xml before starting', async () => {
    const confDir = path.join(tempRoot, 'conf');
    fs.mkdirSync(confDir, { recursive: true });
    const serverXmlPath = path.join(confDir, 'server.xml');
    // Fresh workspace base: Tomcat's defaults, although settings say otherwise
    fs.writeFileSync(serverXmlPath, [
      '<Server port="8005" shutdown="SHUTDOWN">',
      '  <Connector port="8080" protocol="HTTP/1.1" />',
      '</Server>'
    ].join('\n'));
    const internals = tomcat as unknown as {
      port: number;
      shutdownPort: number;
      syncServerXmlPorts(catalinaBase: string): Promise<void>;
    };
    internals.port = 9090;
    internals.shutdownPort = 9005;

    await internals.syncServerXmlPorts(tempRoot);

    const updated = fs.readFileSync(serverXmlPath, 'utf8');
    assert.match(updated, /<Server port="9005"/);
    assert.match(updated, /<Connector port="9090"/);
  });

  describe('buildCommand() paths with spaces', () => {
    it('preserves java executable path when JAVA_HOME contains spaces', () => {
      const javaHomeWithSpaces = process.platform === 'win32'
        ? 'C:\\Program Files\\Java\\jdk-17'
        : '/opt/My Java Home';
      const tomcatHome = process.platform === 'win32'
        ? 'C:\\Program Files\\Apache Tomcat'
        : '/opt/My Tomcat';

      const result = (tomcat as unknown as {
        buildCommand(action: 'start' | 'stop', tomcatHome: string, javaHome: string,
          options?: { debug?: boolean; debugPort?: number; catalinaBase?: string }
        ): { command: string; args: string[] };
      }).buildCommand('start', tomcatHome, javaHomeWithSpaces);

      // The command path must contain the full javaHome/bin/java path (not split on space)
      const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';
      assert.ok(result.command.includes(`bin${path.sep}${javaExe}`));
      assert.ok(result.command.includes('My Java Home'));
      // args must be an array, not a joined string
      assert.strictEqual(Array.isArray(result.args), true);
      assert.ok(result.args.length >= 6);
    });

    it('preserves classpath containing paths with spaces', () => {
      const javaHomeWithSpaces = process.platform === 'win32'
        ? 'C:\\Program Files\\Java\\jdk-17'
        : '/opt/My Java Home';
      const tomcatHomeWithSpaces = process.platform === 'win32'
        ? 'C:\\Program Files\\Apache Tomcat'
        : '/opt/My Tomcat';

      const result = (tomcat as unknown as {
        buildCommand(action: 'start' | 'stop', tomcatHome: string, javaHome: string,
          options?: { debug?: boolean; debugPort?: number; catalinaBase?: string }
        ): { command: string; args: string[] };
      }).buildCommand('stop', tomcatHomeWithSpaces, javaHomeWithSpaces);

      // The -cp argument (index 1) must contain the tomcatHome/bin path with spaces preserved
      const classpathArg = result.args[1];
      assert.ok(classpathArg.includes('bootstrap.jar'));
      assert.ok(classpathArg.includes('tomcat-juli.jar'));
      assert.ok(classpathArg.includes('My Tomcat'));
      // path.delimiter is ';' on Windows, ':' on Unix
      assert.ok(classpathArg.includes(path.delimiter));
    });

    it('preserves -D properties with paths containing spaces', () => {
      const javaHomeWithSpaces = process.platform === 'win32'
        ? 'C:\\Program Files\\Java\\jdk-17'
        : '/opt/My Java Home';
      const tomcatHomeWithSpaces = process.platform === 'win32'
        ? 'C:\\Program Files\\Apache Tomcat'
        : '/opt/My Tomcat';

      const result = (tomcat as unknown as {
        buildCommand(action: 'start' | 'stop', tomcatHome: string, javaHome: string,
          options?: { debug?: boolean; debugPort?: number; catalinaBase?: string }
        ): { command: string; args: string[] };
      }).buildCommand('start', tomcatHomeWithSpaces, javaHomeWithSpaces);

      // -Dcatalina.base, -Dcatalina.home must preserve spaces
      const catalinaBaseArg = result.args.find(a => a.startsWith('-Dcatalina.base='));
      const catalinaHomeArg = result.args.find(a => a.startsWith('-Dcatalina.home='));
      assert.ok(catalinaBaseArg);
      assert.ok(catalinaHomeArg);
      assert.ok(catalinaBaseArg!.includes('My Tomcat'));
      assert.ok(catalinaHomeArg!.includes('My Tomcat'));
    });

    it('produces arguments as array, never a space-joined string', () => {
      const javaHomeWithSpaces = process.platform === 'win32'
        ? 'C:\\Program Files\\Java\\jdk-17'
        : '/opt/My Java Home';
      const tomcatHomeWithSpaces = process.platform === 'win32'
        ? 'C:\\Program Files\\Apache Tomcat'
        : '/opt/My Tomcat';

      const result = (tomcat as unknown as {
        buildCommand(action: 'start' | 'stop', tomcatHome: string, javaHome: string,
          options?: { debug?: boolean; debugPort?: number; catalinaBase?: string }
        ): { command: string; args: string[] };
      }).buildCommand('start', tomcatHomeWithSpaces, javaHomeWithSpaces);

      // Every arg must be a single string, not containing unescaped shell spaces
      for (const arg of result.args) {
        assert.strictEqual(typeof arg, 'string');
        assert.ok(arg.length > 0, `Argument must not be empty: "${arg}"`);
      }
      // First arg is '-cp', second is classpath, then -D properties
      assert.strictEqual(result.args[0], '-cp');
      // The Bootstrap class is at index 5 (args: -cp, classpath, -Dbase, -Dhome, -Dtmpdir, Bootstrap, action)
      assert.strictEqual(result.args[5], 'org.apache.catalina.startup.Bootstrap');
      assert.strictEqual(result.args[6], 'start');
    });
  });
});
