import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Builder } from '../../services/Builder';
import { Tomcat } from '../../services/Tomcat';

describe('Builder Tests', () => {
  let builder: Builder;
  let sandbox: sinon.SinonSandbox;
  let workspaceRoot: string;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turbocat-test-'));
    (Builder as unknown as { instance?: Builder }).instance = undefined;
    (Tomcat as unknown as { instance?: Tomcat }).instance = undefined;
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{
      uri: vscode.Uri.file(workspaceRoot),
      name: path.basename(workspaceRoot),
      index: 0
    }]);
    builder = Builder.getInstance();
  });

  afterEach(() => {
    sandbox.restore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    (Builder as unknown as { instance?: Builder }).instance = undefined;
    (Tomcat as unknown as { instance?: Tomcat }).instance = undefined;
  });

  describe('isJavaEEProject()', () => {
    it('should detect JavaEE project with WEB-INF', () => {
      fs.mkdirSync(path.join(workspaceRoot, 'src', 'main', 'webapp', 'WEB-INF'), { recursive: true });

      assert.strictEqual(Builder.isJavaEEProject(), true);
    });

    it('should detect Maven WAR project', () => {
      fs.writeFileSync(path.join(workspaceRoot, 'pom.xml'), '<project><packaging>war</packaging></project>');

      assert.strictEqual(Builder.isJavaEEProject(), true);
    });

    it('should return false for non-JavaEE projects', () => {
      assert.strictEqual(Builder.isJavaEEProject(), false);
    });
  });

  describe('detectProjectStructure()', () => {
    it('uses the Maven artifactId as the default webapp name', () => {
      fs.writeFileSync(path.join(workspaceRoot, 'pom.xml'), [
        '<project>',
        '  <parent><artifactId>parent-app</artifactId></parent>',
        '  <artifactId>sample-webapp</artifactId>',
        '</project>'
      ].join('\n'));

      const structure = builder.detectProjectStructure();

      assert.strictEqual(structure.type, 'maven');
      assert.strictEqual(structure.defaultWebappName, 'sample-webapp');
      assert.strictEqual(structure.webappName, 'sample-webapp');
    });

    it('detects Gradle projects and reads settings.gradle project names', () => {
      fs.writeFileSync(path.join(workspaceRoot, 'build.gradle'), 'plugins { id "war" }');
      fs.writeFileSync(path.join(workspaceRoot, 'settings.gradle'), 'rootProject.name = "gradle-webapp"');

      const structure = builder.detectProjectStructure();

      assert.strictEqual(structure.type, 'gradle');
      assert.strictEqual(structure.defaultWebappName, 'gradle-webapp');
      assert.strictEqual(structure.webappName, 'gradle-webapp');
    });
  });

  describe('build type candidates', () => {
    it('includes Maven and Gradle only when their build files exist', () => {
      fs.writeFileSync(path.join(workspaceRoot, 'pom.xml'), '<project />');
      fs.writeFileSync(path.join(workspaceRoot, 'build.gradle'), 'plugins { id "war" }');

      const candidates = (builder as unknown as {
        collectBuildCandidates(projectDir: string): Array<'Local' | 'Maven' | 'Gradle'>;
      }).collectBuildCandidates(workspaceRoot);

      assert.deepStrictEqual(candidates, ['Local', 'Maven', 'Gradle']);
    });
  });

  describe('smart deploy deletion', () => {
    it('removes deployed compiled classes when their source class file is deleted', async () => {
      const tomcatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'turbocat-home-test-'));
      try {
        fs.mkdirSync(path.join(tomcatHome, 'conf'), { recursive: true });
        fs.writeFileSync(path.join(tomcatHome, 'conf', 'server.xml'), '<Server port="8005" />');
        const deployedClass = path.join(workspaceRoot, '.vscode', 'turbocat', 'webapps', 'sample-webapp', 'WEB-INF', 'classes', 'com', 'example', 'Foo.class');
        fs.mkdirSync(path.dirname(deployedClass), { recursive: true });
        fs.writeFileSync(deployedClass, 'compiled');

        sandbox.stub(Tomcat.getInstance(), 'findTomcatHome').resolves(tomcatHome);
        (builder as unknown as { projectStructure: { webappName: string } }).projectStructure = {
          webappName: 'sample-webapp'
        };
        (builder as unknown as { compiledMappings: unknown[] }).compiledMappings = [{
          source: 'target/classes/**/*.class',
          destination: 'WEB-INF/classes/{relative}',
          needsReload: true,
          description: 'Java compiled classes',
          extensions: ['.class'],
          absoluteSource: '',
          absoluteDestination: '',
          sourceRegex: /^target\/classes\/.*\.class$/,
          origin: 'smart'
        }];

        await (builder as unknown as {
          executeCompiledFileDeployment(filePath: string, eventType: 'change' | 'create' | 'delete'): Promise<void>;
        }).executeCompiledFileDeployment(
          path.join(workspaceRoot, 'target', 'classes', 'com', 'example', 'Foo.class'),
          'delete'
        );

        assert.strictEqual(fs.existsSync(deployedClass), false);
      } finally {
        fs.rmSync(tomcatHome, { recursive: true, force: true });
      }
    });
  });
});
