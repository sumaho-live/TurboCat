import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Builder } from '../../services/Builder';
import { Tomcat } from '../../services/Tomcat';
import { Logger } from '../../services/Logger';
import { JavaReadiness } from '../../services/JavaReadiness';

describe('Builder Tests', () => {
  let builder: Builder;
  let sandbox: sinon.SinonSandbox;
  let workspaceRoot: string;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turbocat-test-'));
    Builder.clearInstancesForTests();
    Tomcat.clearInstancesForTests();
    Logger.clearInstancesForTests();
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
    Builder.clearInstancesForTests();
    Tomcat.clearInstancesForTests();
    Logger.clearInstancesForTests();
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

    it('deploys a pure Eclipse WTP project using its configured output and all web roots', async () => {
      sandbox.stub(Tomcat.getInstance(), 'findTomcatHome').resolves(null);
      fs.writeFileSync(
        path.join(workspaceRoot, '.classpath'),
        '<classpath><classpathentry path="src" kind="src" output="build/generated-classes"/><classpathentry path="build/eclipse-bin" kind="output"/></classpath>'
      );
      const settingsDir = path.join(workspaceRoot, '.settings');
      fs.mkdirSync(settingsDir);
      fs.writeFileSync(
        path.join(settingsDir, 'org.eclipse.wst.common.component'),
        '<project-modules><wb-module deploy-name="eclipse-app"><wb-resource source-path="/WebContent" deploy-path="/"/><wb-resource source-path="/generated-web" deploy-path="/"/></wb-module></project-modules>'
      );
      const classDir = path.join(workspaceRoot, 'build', 'eclipse-bin', 'com', 'example');
      fs.mkdirSync(classDir, { recursive: true });
      fs.writeFileSync(path.join(classDir, 'App.class'), 'compiled');
      const generatedClassDir = path.join(workspaceRoot, 'build', 'generated-classes', 'generated');
      fs.mkdirSync(generatedClassDir, { recursive: true });
      fs.writeFileSync(path.join(generatedClassDir, 'Generated.class'), 'compiled');
      fs.mkdirSync(path.join(workspaceRoot, 'WebContent'));
      fs.writeFileSync(path.join(workspaceRoot, 'WebContent', 'index.jsp'), 'page');
      fs.mkdirSync(path.join(workspaceRoot, 'generated-web'));
      fs.writeFileSync(path.join(workspaceRoot, 'generated-web', 'generated.txt'), 'generated');

      const structure = builder.detectProjectStructure();
      const targetDir = path.join(workspaceRoot, 'deployed');
      await (builder as unknown as {
        preBuiltDeploy(projectDir: string, targetDir: string, tomcatHome: string, progress?: unknown): Promise<void>;
      }).preBuiltDeploy(workspaceRoot, targetDir, '/tmp/fake-tomcat');

      assert.strictEqual(structure.type, 'eclipse');
      assert.strictEqual(structure.javaOutputDir, 'build/eclipse-bin');
      assert.strictEqual(fs.existsSync(path.join(targetDir, 'index.jsp')), true);
      assert.strictEqual(fs.existsSync(path.join(targetDir, 'generated.txt')), true);
      assert.strictEqual(
        fs.existsSync(path.join(targetDir, 'WEB-INF', 'classes', 'com', 'example', 'App.class')),
        true
      );
      assert.strictEqual(
        fs.existsSync(path.join(targetDir, 'WEB-INF', 'classes', 'generated', 'Generated.class')),
        true
      );
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

  describe('findRecentSiblingClasses()', () => {
    it('returns only recently written classes from the given package directories', async () => {
      const pkg = path.join(workspaceRoot, 'target', 'classes', 'com', 'a');
      const other = path.join(workspaceRoot, 'target', 'classes', 'com', 'b');
      fs.mkdirSync(pkg, { recursive: true });
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'Fresh.class'), '');
      fs.writeFileSync(path.join(pkg, 'notes.txt'), '');
      const stale = path.join(pkg, 'Stale.class');
      fs.writeFileSync(stale, '');
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(stale, old, old);
      fs.writeFileSync(path.join(other, 'Elsewhere.class'), '');

      const found = await (builder as unknown as {
        findRecentSiblingClasses(dirs: Iterable<string>): Promise<string[]>;
      }).findRecentSiblingClasses([pkg]);

      assert.deepStrictEqual(found.map(f => path.basename(f)), ['Fresh.class']);
    });
  });

  describe('copyFileWithLogging()', () => {
    type Copier = { copyFileWithLogging(s: string, t: string, type: 'class' | 'static' | 'local'): Promise<boolean> };

    it('skips targets that already hold identical bytes', async () => {
      const source = path.join(workspaceRoot, 'A.class');
      const target = path.join(workspaceRoot, 'out', 'A.class');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(source, 'same');
      fs.writeFileSync(target, 'same');
      const past = new Date(Date.now() - 60000);
      fs.utimesSync(target, past, past);

      const copied = await (builder as unknown as Copier).copyFileWithLogging(source, target, 'class');

      assert.strictEqual(copied, false);
      assert.strictEqual(fs.statSync(target).mtimeMs, past.getTime());
    });

    it('copies changed content once and skips the repeated trigger', async () => {
      const source = path.join(workspaceRoot, 'a.jsp');
      const target = path.join(workspaceRoot, 'out', 'a.jsp');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(source, 'new');
      fs.writeFileSync(target, 'old');

      const copier = builder as unknown as Copier;
      assert.strictEqual(await copier.copyFileWithLogging(source, target, 'static'), true);
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
      assert.strictEqual(await copier.copyFileWithLogging(source, target, 'static'), false);
    });
  });

  describe('scheduleReloadIfNeeded()', () => {
    type Reloader = {
      autoDeployMode: string;
      scheduleReloadIfNeeded(mapping: { needsReload: boolean }, file: string): void;
    };

    const runReload = async (state: 'stopped' | 'run' | 'debug', needsReload = true) => {
      const tomcat = Tomcat.getInstance();
      sandbox.stub(tomcat, 'getRunState').resolves(state);
      const reload = sandbox.stub(tomcat, 'reload').resolves();
      const clock = sandbox.useFakeTimers();
      const reloader = builder as unknown as Reloader;
      reloader.autoDeployMode = 'Smart';
      reloader.scheduleReloadIfNeeded({ needsReload }, '/x/A.class');
      reloader.scheduleReloadIfNeeded({ needsReload }, '/x/B.class');
      await clock.tickAsync(5000);
      clock.restore();
      return reload.callCount;
    };

    it('restarts Tomcat once for a burst of reload-worthy changes', async () => {
      assert.strictEqual(await runReload('run'), 1);
    });

    it('does not restart in debug mode, when stopped, or for mappings without needsReload', async () => {
      assert.strictEqual(await runReload('debug'), 0);
      sandbox.restore();
      assert.strictEqual(await runReload('stopped'), 0);
      sandbox.restore();
      assert.strictEqual(await runReload('run', false), 0);
    });
  });

  describe('waitForJavaReady()', () => {
    type Gate = {
      autoDeployMode: string;
      smartDeployGeneration: number;
      waitForJavaReady(generation: number): Promise<boolean>;
    };

    it('passes straight through when Java is already ready', async () => {
      sandbox.stub(JavaReadiness, 'isReady').returns(true);
      const gate = builder as unknown as Gate;
      gate.autoDeployMode = 'Smart';
      assert.strictEqual(await gate.waitForJavaReady(gate.smartDeployGeneration), true);
    });

    it('keeps smart deploy off when the Java server fails to become ready', async () => {
      sandbox.stub(JavaReadiness, 'isReady').returns(false);
      sandbox.stub(JavaReadiness, 'whenReady').resolves(false);
      const gate = builder as unknown as Gate;
      gate.autoDeployMode = 'Smart';
      assert.strictEqual(await gate.waitForJavaReady(gate.smartDeployGeneration), false);
    });

    it('gives up when smart deploy is disposed while waiting for Java', async () => {
      sandbox.stub(JavaReadiness, 'isReady').returns(false);
      let release!: (value: boolean) => void;
      sandbox.stub(JavaReadiness, 'whenReady').returns(new Promise(resolve => { release = resolve; }));
      const gate = builder as unknown as Gate;
      gate.autoDeployMode = 'Smart';
      const pending = gate.waitForJavaReady(gate.smartDeployGeneration);
      builder.disposeSmartDeploy();
      release(true);
      assert.strictEqual(await pending, false);
    });
  });
});
