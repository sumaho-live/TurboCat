import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { Tomcat } from '../../services/Tomcat';

describe('Tomcat Tests', () => {
  let tomcat: Tomcat;
  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turbocat-tomcat-test-'));
    (Tomcat as unknown as { instance?: Tomcat }).instance = undefined;
    tomcat = Tomcat.getInstance();
  });

  afterEach(() => {
    sandbox.restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    (Tomcat as unknown as { instance?: Tomcat }).instance = undefined;
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
