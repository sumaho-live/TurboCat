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
        collectBuildCandidates(projectDir: string): Array<'Local' | 'Maven' | 'Gradle' | 'PreBuilt'>;
      }).collectBuildCandidates(workspaceRoot);

      assert.deepStrictEqual(candidates, ['Local', 'Maven', 'Gradle']);
    });

    it('includes PreBuilt when pom.xml and target/classes exist', () => {
      fs.writeFileSync(path.join(workspaceRoot, 'pom.xml'), '<project />');
      fs.mkdirSync(path.join(workspaceRoot, 'target', 'classes'), { recursive: true });

      const candidates = (builder as unknown as {
        collectBuildCandidates(projectDir: string): Array<'Local' | 'Maven' | 'Gradle' | 'PreBuilt'>;
      }).collectBuildCandidates(workspaceRoot);

      assert.deepStrictEqual(candidates, ['Local', 'Maven', 'PreBuilt']);
    });

    it('does not include PreBuilt when target/classes is missing', () => {
      fs.writeFileSync(path.join(workspaceRoot, 'pom.xml'), '<project />');

      const candidates = (builder as unknown as {
        collectBuildCandidates(projectDir: string): Array<'Local' | 'Maven' | 'Gradle' | 'PreBuilt'>;
      }).collectBuildCandidates(workspaceRoot);

      assert.deepStrictEqual(candidates, ['Local', 'Maven']);
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

  describe('preBuiltDeploy()', () => {
    it('deploys pre-built classes and web resources without running mvn', async () => {
      const tomcatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'turbocat-pb-test-'));
      try {
        fs.mkdirSync(path.join(tomcatHome, 'conf'), { recursive: true });
        fs.writeFileSync(path.join(tomcatHome, 'conf', 'server.xml'), '<Server port="8005" />');
        sandbox.stub(Tomcat.getInstance(), 'findTomcatHome').resolves(tomcatHome);

        // Set up Maven project
        fs.writeFileSync(path.join(workspaceRoot, 'pom.xml'), '<project><artifactId>test-app</artifactId></project>');

        // Create pre-built classes
        const classDir = path.join(workspaceRoot, 'target', 'classes', 'com', 'example');
        fs.mkdirSync(classDir, { recursive: true });
        fs.writeFileSync(path.join(classDir, 'Hello.class'), 'compiled-by-java-ls');

        // Create web resource
        const webappDir = path.join(workspaceRoot, 'src', 'main', 'webapp');
        fs.mkdirSync(webappDir, { recursive: true });
        fs.writeFileSync(path.join(webappDir, 'index.jsp'), '<html></html>');

        // Set target dir (simulating webapps/ROOT)
        const targetDir = path.join(workspaceRoot, '.vscode', 'turbocat', 'webapps', 'test-app');
        (builder as unknown as { projectStructure: { type: string; javaOutputDir: string; javaSourceRoots: string[]; webResourceRoots: string[]; webappName: string; defaultWebappName: string } | undefined }).projectStructure = undefined;
        sandbox.stub(builder as unknown as { detectProjectStructure(): { type: string; javaOutputDir: string; javaSourceRoots: string[]; webResourceRoots: string[]; webappName: string; defaultWebappName: string } }, 'detectProjectStructure').returns({
          type: 'maven',
          javaOutputDir: 'target/classes',
          javaSourceRoots: ['src/main/java'],
          webResourceRoots: ['src/main/webapp'],
          webappName: 'test-app',
          defaultWebappName: 'test-app'
        });

        await (builder as unknown as {
          preBuiltDeploy(projectDir: string, targetDir: string, tomcatHome: string, progress?: unknown): Promise<void>;
        }).preBuiltDeploy(workspaceRoot, targetDir, tomcatHome);

        // Verify web resource was deployed
        assert.strictEqual(fs.existsSync(path.join(targetDir, 'index.jsp')), true);
        // Verify class was deployed
        assert.strictEqual(
          fs.existsSync(path.join(targetDir, 'WEB-INF', 'classes', 'com', 'example', 'Hello.class')),
          true
        );
      } finally {
        fs.rmSync(tomcatHome, { recursive: true, force: true });
      }
    });

    it('throws when target/classes is missing', async () => {
      fs.writeFileSync(path.join(workspaceRoot, 'pom.xml'), '<project />');

      await assert.rejects(
        (builder as unknown as {
          preBuiltDeploy(projectDir: string, targetDir: string, tomcatHome: string, progress?: unknown): Promise<void>;
        }).preBuiltDeploy(workspaceRoot, '/tmp/fake-target', '/tmp/fake-tomcat'),
        /target.classes not found/
      );
    });
  });

  describe('executeCommandSpawn() paths with spaces', () => {
    it('passes command and args array directly to spawn (not a space-joined string)', async () => {
      const builderPriv = builder as unknown as {
        executeCommandSpawn(command: string, args: string[], cwd: string): Promise<void>;
      };

      const expected = 'path segment with spaces';
      const script = [
        `const expected = ${JSON.stringify(expected)};`,
        'if (process.argv[1] !== expected) {',
        '  console.error(`expected "${expected}", got "${process.argv[1]}"`);',
        '  process.exit(1);',
        '}'
      ].join(' ');

      await builderPriv.executeCommandSpawn(
        process.execPath,
        ['-e', script, expected],
        workspaceRoot
      );
    });

    it('resolves successfully with paths containing spaces', async () => {
      const builderPriv = builder as unknown as {
        executeCommandSpawn(command: string, args: string[], cwd: string): Promise<void>;
      };

      const command = process.execPath;
      const args = ['-e', 'process.exit(0)'];

      // Should resolve without throwing
      await builderPriv.executeCommandSpawn(command, args, workspaceRoot);
    });
  });

  describe('local deploy handles paths with spaces', () => {
    it('does not escape backslashes for cmd.exe in javac args construction', () => {
      const sourceCode = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'src', 'services', 'Builder.ts'), 'utf8'
      );
      assert.strictEqual(sourceCode.includes('escapeForCmd'), false,
        'escapeForCmd function should be removed from Builder.ts');
    });

    it('uses executeCommandSpawn instead of executeCommand for javac', () => {
      const sourceCode = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'src', 'services', 'Builder.ts'), 'utf8'
      );
      assert.strictEqual(sourceCode.includes('executeCommandSpawn'), true,
        'executeCommandSpawn should be present in Builder.ts');
    });
  });

  describe('globToRegex() matches root-level files', () => {
    it('matches a file directly under the watched root', () => {
      const globToRegex = (builder as unknown as {
        globToRegex(globPattern: string): string;
      }).globToRegex;

      const regex = globToRegex('src/main/webapp/**/*');
      const pattern = new RegExp('^' + regex + '$');

      // File at root: should match
      assert.ok(pattern.test('src/main/webapp/TestCode.jsp'),
        'Root-level file should match the regex');
      // File in subdirectory: should match
      assert.ok(pattern.test('src/main/webapp/subdir/TestCode.jsp'),
        'Nested file should match the regex');
      // File with extension excluded: should still match pattern (exclusion is checked separately)
      assert.ok(pattern.test('src/main/webapp/foo.java'),
        'Java file in root should match the glob pattern (excluded later by extensions)');
      // File in wrong directory: should NOT match
      assert.strictEqual(pattern.test('src/main/resources/foo.xml'), false,
        'File in wrong directory should not match');
    });

    it('matches class files at root of output directory', () => {
      const globToRegex = (builder as unknown as {
        globToRegex(globPattern: string): string;
      }).globToRegex;

      const regex = globToRegex('target/classes/**/*.class');
      const pattern = new RegExp('^' + regex + '$');

      // Class at package root? Unlikely in Java, but pattern should handle it
      assert.ok(pattern.test('target/classes/Evento.class'),
        'Class at root of output dir should match');
      assert.ok(pattern.test('target/classes/com/example/Evento.class'),
        'Class in package should match');
    });
  });

  describe('findDirectClassMatches() is package-aware', () => {
    it('restricts search to the specified package when javaPackage is provided', async () => {
      const findMatch = (builder as unknown as {
        findDirectClassMatches(outputDir: string, className: string, javaPackage?: string): Promise<string[]>;
      }).findDirectClassMatches;

      // Create test class files in different packages
      const correctPkg = path.join(workspaceRoot, 'target', 'classes', 'com', 'aaa', 'calendario_accademico');
      const wrongPkg = path.join(workspaceRoot, 'target', 'classes', 'com', 'other', 'service');
      fs.mkdirSync(correctPkg, { recursive: true });
      fs.mkdirSync(wrongPkg, { recursive: true });
      fs.writeFileSync(path.join(correctPkg, 'Evento.class'), '');
      fs.writeFileSync(path.join(wrongPkg, 'Evento.class'), '');

      const outputDir = path.join(workspaceRoot, 'target', 'classes');

      // Without package restriction (backward compat): should find both
      const allMatches = await findMatch(outputDir, 'Evento');
      assert.strictEqual(allMatches.length, 2);

      // With correct package restriction: should find only one
      const correctMatches = await findMatch(outputDir, 'Evento', 'com/aaa/calendario_accademico');
      assert.strictEqual(correctMatches.length, 1);
      assert.ok(correctMatches[0].includes('calendario_accademico'));
    });

    it('falls back to broad search when javaPackage is empty', async () => {
      const findMatch = (builder as unknown as {
        findDirectClassMatches(outputDir: string, className: string, javaPackage?: string): Promise<string[]>;
      }).findDirectClassMatches;

      const pkgDir = path.join(workspaceRoot, 'target', 'classes', 'com', 'test');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'MyClass.class'), '');

      const outputDir = path.join(workspaceRoot, 'target', 'classes');
      const matches = await findMatch(outputDir, 'MyClass', '');
      assert.strictEqual(matches.length, 1);
      assert.ok(matches[0].includes('MyClass.class'));
    });
  });

  describe('checkAndDeployCompiledClass() passes package to findDirectClassMatches', () => {
    it('extracts package from Java source path and restricts class search', async () => {
      // Set up project structure with known source root
      (builder as unknown as {
        projectStructure: { type: string; javaOutputDir: string; javaSourceRoots: string[]; webResourceRoots: string[]; webappName: string; defaultWebappName: string } | undefined
      }).projectStructure = {
        type: 'maven',
        javaOutputDir: 'target/classes',
        javaSourceRoots: ['src/main/java'],
        webResourceRoots: ['src/main/webapp'],
        webappName: 'test-app',
        defaultWebappName: 'test-app'
      };

      // Create class files: one in the correct package, one in a different package
      const correctPkgDir = path.join(workspaceRoot, 'target', 'classes', 'com', 'aaa', 'calendario');
      const wrongPkgDir = path.join(workspaceRoot, 'target', 'classes', 'com', 'other', 'svc');
      fs.mkdirSync(correctPkgDir, { recursive: true });
      fs.mkdirSync(wrongPkgDir, { recursive: true });
      fs.writeFileSync(path.join(correctPkgDir, 'Evento.class'), '');
      fs.writeFileSync(path.join(wrongPkgDir, 'Evento.class'), '');

      // Spy on findDirectClassMatches to verify it receives the correct javaPackage
      let receivedPackage: string | undefined;
      const origFind = (builder as unknown as {
        findDirectClassMatches(outputDir: string, className: string, javaPackage?: string): Promise<string[]>;
      }).findDirectClassMatches;
      const spy = sandbox.stub().callsFake(
        async (outputDir: string, className: string, javaPackage?: string) => {
          receivedPackage = javaPackage;
          return origFind(outputDir, className, javaPackage);
        }
      );
      (builder as unknown as { findDirectClassMatches: typeof spy }).findDirectClassMatches = spy;

      // Call checkAndDeployCompiledClass with a source path that implies a package
      const javaSourcePath = path.join(workspaceRoot, 'src', 'main', 'java', 'com', 'aaa', 'calendario', 'Evento.java');
      await (builder as unknown as {
        checkAndDeployCompiledClass(javaFilePath: string, className: string): Promise<void>;
      }).checkAndDeployCompiledClass(javaSourcePath, 'Evento');

      // The spy should have been called with javaPackage derived from the source path
      assert.ok(spy.called, 'findDirectClassMatches should have been called');
      // Package should be com/aaa/calendario (forward slashes, normalized)
      assert.strictEqual(receivedPackage, 'com/aaa/calendario',
        `Expected package 'com/aaa/calendario' but got '${receivedPackage}'`);
    });
  });
});
