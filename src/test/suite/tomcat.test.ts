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
});
