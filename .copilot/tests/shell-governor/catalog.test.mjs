// Catalog and classification checks. Cases are ported from the S4/S6 spike selftests (bench/s4-selftest.mjs,
// bench/s6-selftest.mjs); the spike id is kept in each comment. Worker argv is replaced by synthetic fixtures that
// have the worker's shape (flags keep their dash in raw; words are constants).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigStore } from '../../extensions/shell-governor/lib/config.mjs';
import {
    DEFAULT_CATALOG_DIR, buildCatalog, catalogFromGroups, isProviderHost, loadCatalog, normalizeCmdlet, normalizeNative,
    officialReadEligible, parseNative, providerHostsOf, registerCatalogGroups,
} from '../../extensions/shell-governor/lib/catalog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_ROOT = join(HERE, '..', '..', 'extensions', 'shell-governor');
const COPILOT_HOME = join(HERE, 'fixtures', 'config', 'copilot-home');
const CWD = 'C:\\code\\repo';
const catalog = loadCatalog();

/** Worker-shaped flag: name without dashes, raw with them. */
const flag = (raw) => ({ k: 'param', name: raw.replace(/^-+/, ''), raw });
/** Worker-shaped constant word. */
const word = (value) => ({ k: 'word', raw: value, value, isConst: true });
/** Worker-shaped native command. */
const native = (name, args, extra = {}) => ({ name, inv: 'command', args, cwd: CWD, redirs: [], ...extra });
/** Worker-shaped cmdlet. */
const cmdlet = (name, args) => ({ name, inv: 'cmdlet', args, cwd: CWD, redirs: [] });

const toolSpec = (name) => {
    const spec = catalog.tools.get(name);
    assert.ok(spec, `catalog has tool "${name}"`);
    return spec;
};
/** Normalizes a native command with the spec of its name. */
const classify = (cmd) => normalizeNative(cmd, toolSpec(cmd.name), {});

// ---- catalog layout and registration ----

test('loadCatalog_ShippedDirectory_OneSpecPerFileAndCoreLoaded', () => {
    // Arrange
    const files = readdirSync(DEFAULT_CATALOG_DIR).filter((f) => f.endsWith('.json'));

    // Act
    const specs = new Set(catalog.tools.values());

    // Assert
    assert.equal(catalog.core.kind, 'pwsh-core');
    assert.equal(specs.size, files.length - 1, 'every file except pwsh-core.json is one tool spec'); // D-18
});

test('loadCatalog_ExecutableWithExeSuffix_IsKeyedWithoutSuffix', () => {
    // Arrange
    const names = ['snow', 'snow.exe', 'tofu'];

    // Act
    const found = names.map((n) => catalog.tools.get(n)?.tool ?? null);

    // Assert
    assert.deepEqual(found, ['snow', null, 'terraform']); // A9 (catalog part: worker basename resolves to the tool)
});

test('buildCatalog_SameExecutableInTwoTools_Throws', () => {
    // Arrange
    const a = { tool: 'a', executables: ['dup.exe'], ops: [], default: 'unknown' };
    const b = { tool: 'b', executables: ['DUP'], ops: [], default: 'unknown' };
    const entries = [
        { name: 'pwsh-core.json', value: catalog.core },
        { name: 'a.json', value: a },
        { name: 'b.json', value: b },
    ];

    // Act / Assert
    assert.throws(() => buildCatalog(entries), /already belongs to tool "a"/);
});

test('buildCatalog_NoCoreDocument_Throws', () => {
    // Arrange
    const entries = [{ name: 'git.json', value: { tool: 'git', executables: ['git'], ops: [], default: 'unknown' } }];

    // Act / Assert
    assert.throws(() => buildCatalog(entries), /pwsh-core\.json/);
});

test('registerCatalogGroups_ShippedDirectory_BuildsTheSameTools', () => {
    // Arrange
    const store = createConfigStore({ rootDir: RULES_ROOT, copilotHome: COPILOT_HOME, onWarning: () => {} });

    // Act
    const names = registerCatalogGroups(store);
    const built = catalogFromGroups(store.get().groups);

    // Assert
    assert.equal(names.length, readdirSync(DEFAULT_CATALOG_DIR).filter((f) => f.endsWith('.json')).length);
    assert.deepEqual([...built.tools.keys()].sort(), [...catalog.tools.keys()].sort());
});

test('catalogFromGroups_EditedCatalogFile_ReflectsNewClassOnNextGet', (t) => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const gitFile = join(dir, 'git.json');
    copyFileSync(join(DEFAULT_CATALOG_DIR, 'git.json'), gitFile);
    copyFileSync(join(DEFAULT_CATALOG_DIR, 'pwsh-core.json'), join(dir, 'pwsh-core.json'));
    const store = createConfigStore({ rootDir: RULES_ROOT, copilotHome: COPILOT_HOME, onWarning: () => {} });
    registerCatalogGroups(store, dir);
    const statusClass = () => {
        const built = catalogFromGroups(store.get().groups);
        return normalizeNative(native('git', [word('status')]), built.tools.get('git'), {}).cls;
    };
    const before = statusClass();
    const spec = JSON.parse(readFileSync(gitFile, 'utf8'));
    spec.ops[0] = { ...spec.ops[0], class: 'delete' }; // git.read (status) becomes delete

    // Act
    writeFileSync(gitFile, JSON.stringify(spec, null, 2));
    const later = new Date(Date.now() + 10000);
    utimesSync(gitFile, later, later);
    const after = statusClass();

    // Assert
    assert.equal(before, 'read');
    assert.equal(after, 'delete');
});

test('isProviderHost_SubdomainOfProvider_IsTrueOtherHostIsFalse', () => {
    // Arrange
    const bucketHost = 'bucket.s3.amazonaws.com';
    const otherHost = 'evil.example.invalid';

    // Act
    const bucket = isProviderHost(bucketHost, catalog);
    const other = isProviderHost(otherHost, catalog);

    // Assert
    assert.equal(bucket, true);
    assert.equal(other, false);
});

test('providerHostsOf_ShippedCatalog_KeepsTheEightProviderHosts', () => {
    // Arrange
    const expected = [
        'amazonaws.com', 'api.github.com', 'dev.azure.com', 'github.com', 'graph.microsoft.com',
        'login.microsoftonline.com', 'management.azure.com', 'visualstudio.com',
    ];

    // Act
    const hosts = providerHostsOf(catalog);

    // Assert
    assert.deepEqual(hosts, expected); // moved from engine PROVIDER_HOSTS into the catalog specs
});

// ---- argv parsing ----

test('parseNative_GhApiMethodFlag_KeepsPostValue', () => {
    // Arrange
    const args = [word('api'), flag('-X'), word('POST'), word('repos/a/b/x')];

    // Act
    const parsed = parseNative(toolSpec('gh'), args);

    // Assert
    assert.equal(parsed.flags.find((f) => f.name === '-X')?.value, 'POST'); // A4
});

// ---- native classification (ported spike cases) ----

test('Catalog_GitBranchShowCurrentWithNoPager_IsReadBranch', () => {
    // Arrange
    const cmd = native('git', [flag('--no-pager'), word('branch'), flag('--show-current')]);

    // Act
    const result = classify(cmd);

    // Assert
    assert.equal(result.cls, 'read'); // A3: --no-pager does not eat the subcommand
    assert.ok(String(result.opId).startsWith('git.branch'), result.opId);
});

test('Catalog_SnowSqlQueryLiteral_IsReadWithSqlInfo', () => {
    // Arrange
    const cmd = native('snow', [flag('-c'), word('example_prod'), word('sql'), flag('-q'), word('select current_role()')]);

    // Act
    const result = classify(cmd);

    // Assert
    assert.equal(result.cls, 'read'); // A5
    assert.equal(result.sqlInfo?.kind, 'sql');
});

test('Catalog_SnowSqlDeleteWithComments_IsRemoteDestructive', () => {
    // Arrange
    const cmd = native('snow', [word('sql'), flag('-q'), word('-- note\n/* x */ DELETE FROM t WHERE id = 1')]);

    // Act
    const result = classify(cmd);

    // Assert
    assert.equal(result.cls, 'remote-destructive'); // A5b
});

test('Catalog_DotnetAddPackage_IsInstall', () => {
    // Arrange
    const cmd = native('dotnet', [word('add'), word('package'), word('Foo'), flag('--version'), word('8.0.1')]);

    // Act
    const result = classify(cmd);

    // Assert
    assert.equal(result.cls, 'install'); // B1 (regression: was a false SAFE)
});

test('Catalog_PythonScriptNotPy_IsUnknown', () => {
    // Arrange
    const cmd = native('python', [word('bench/replay/s4-run.mjs')]);

    // Act
    const result = classify(cmd);

    // Assert
    assert.equal(result.cls, 'unknown'); // B4a: .mjs given to python is not a script kind
});

test('Catalog_PythonStdinDashPiped_IsInlineExecute', () => {
    // Arrange
    const cmd = native('python', [word('-')], { pipedFrom: true });

    // Act
    const result = classify(cmd);

    // Assert
    assert.equal(result.cls, 'execute-code'); // F3
    assert.equal(result.execKind, 'inline');
});

test('Catalog_DotnetScriptFile_ScriptPathIsTheFileNotTheSubcommand', () => {
    // Arrange
    const cmd = native('dotnet', [word('script'), word('tools/x.csx')]);

    // Act
    const result = classify(cmd);

    // Assert
    const script = result.paths.find((p) => p.kind === 'script');
    assert.ok(script?.full?.toLowerCase().endsWith('\\tools\\x.csx'), JSON.stringify(result.paths)); // F4
});

test('Catalog_NodeScriptFile_ScriptPathIsDetected', () => {
    // Arrange
    const cmd = native('node', [word('tools/run.js')]);

    // Act
    const result = classify(cmd);

    // Assert
    const script = result.paths.find((p) => p.kind === 'script');
    assert.ok(script?.full?.toLowerCase().endsWith('\\tools\\run.js'), JSON.stringify(result.paths)); // F5
});

test('Catalog_NewObjectWebClient_IsUnknown', () => {
    // Arrange
    const cmd = cmdlet('new-object', [word('Net.WebClient')]);

    // Act
    const result = normalizeCmdlet(cmd, catalog.core);

    // Assert
    assert.equal(result.cls, 'unknown'); // F2
});

// ---- credential reads (D-28) ----

// ---- credential cmdlets (TFIX-2a W5) ----

test('Catalog_SecretReturningCmdlets_AreCredential', () => {
    // Arrange
    const names = [
        'get-azaccesstoken', 'get-azkeyvaultsecret', 'get-azstorageaccountkey', 'get-credential', 'convertfrom-securestring',
        'get-azrediscachekey', 'get-azwebapppublishingprofile', 'new-azstoragecontainersastoken', 'get-secret', 'get-secretinfo-x',
    ];

    // Act
    const results = names.map((n) => normalizeCmdlet(cmdlet(n, []), catalog.core, {}));

    // Assert
    assert.deepEqual(results.map((r) => r.cls), names.map(() => 'credential'));
});

test('Catalog_PlainAzCmdlets_AreNotCredential', () => {
    // Arrange
    const names = ['get-azresourcegroup', 'get-azvm', 'get-azcontext', 'get-azstorageaccount'];

    // Act
    const results = names.map((n) => normalizeCmdlet(cmdlet(n, []), catalog.core, {}));

    // Assert
    assert.ok(results.every((r) => r.cls !== 'credential'), JSON.stringify(results.map((r) => r.cls)));
});

test('Catalog_KubectlGetSecret_IsCredential', () => {
    // Arrange
    const commands = [
        native('kubectl', [word('get'), word('secret'), word('db-creds'), flag('-n'), word('prod'), flag('-o'), word('yaml')]),
        native('kubectl', [word('describe'), word('secrets')]),
        native('kubectl', [word('get'), word('secret/db-creds')]),
    ];

    // Act
    const results = commands.map(classify);

    // Assert
    assert.deepEqual(results.map((r) => r.cls), ['credential', 'credential', 'credential']);
});

test('Catalog_AzKeyvaultSecretShow_IsCredential', () => {
    // Arrange
    const commands = [
        native('az', [word('keyvault'), word('secret'), word('show'), flag('--name'), word('s1'), flag('--vault-name'), word('kv1')]),
        native('az', [word('keyvault'), word('secret'), word('download'), flag('--name'), word('s1')]),
    ];

    // Act
    const results = commands.map(classify);

    // Assert
    assert.deepEqual(results.map((r) => r.cls), ['credential', 'credential']);
});

test('Catalog_AzKeysList_IsCredential', () => {
    // Arrange
    const commands = [
        native('az', [word('storage'), word('account'), word('keys'), word('list'), flag('-g'), word('rg')]),
        native('az', [word('webapp'), word('list-keys'), flag('-g'), word('rg'), flag('-n'), word('app')]),
        native('az', [word('cosmosdb'), word('keys'), word('list'), flag('-g'), word('rg')]),
    ];

    // Act
    const results = commands.map(classify);

    // Assert
    assert.deepEqual(results.map((r) => r.cls), ['credential', 'credential', 'credential']);
});

test('Catalog_AzStorageAccountList_IsNotCredential', () => {
    // Arrange
    const cmd = native('az', [word('storage'), word('account'), word('list'), flag('-g'), word('rg')]);

    // Act
    const result = classify(cmd);

    // Assert
    assert.equal(result.cls, 'read-remote');
});

test('Catalog_GhPrViewWithoutS6Flags_StaysReadRemote', () => {
    // Arrange
    const cmd = native('gh', [word('pr'), word('view'), word('12')]);

    // Act
    const result = classify(cmd);

    // Assert
    assert.equal(result.cls, 'read-remote'); // R1: the class is unchanged; the policy decides the verdict
});

// ---- official-CLI reads (S6 d1-d16; the verdict rules are in the policy engine) ----

const OFFICIAL_READ_CASES = [
    { id: 'd1', name: 'Catalog_GhApiGetWithoutFields_IsOfficialReadEligible', cmd: native('gh', [word('api'), word('repos/a/b/pulls')]), cls: 'read-remote', eligible: true },
    { id: 'd2', name: 'Catalog_GhApiWithFieldFlag_IsNotOfficialReadEligible', cmd: native('gh', [word('api'), word('repos/a/b'), flag('-f'), word('title=x')]), cls: 'admin', eligible: false },
    { id: 'd3', name: 'Catalog_GhApiMethodPost_IsNotOfficialReadEligible', cmd: native('gh', [word('api'), word('repos/a/b'), flag('-X'), word('POST')]), cls: 'admin', eligible: false },
    { id: 'd4', name: 'Catalog_GhPrView_IsOfficialReadEligible', cmd: native('gh', [word('pr'), word('view'), word('12'), flag('--json'), word('title')]), cls: 'read-remote', eligible: true },
    { id: 'd5', name: 'Catalog_GhPrCreate_IsNotOfficialReadEligible', cmd: native('gh', [word('pr'), word('create'), flag('--title'), word('x')]), cls: 'publish', eligible: false },
    { id: 'd6', name: 'Catalog_AzBoardsList_IsOfficialReadEligible', cmd: native('az', [word('boards'), word('work-item'), word('list'), flag('--project'), word('p')]), cls: 'read-remote', eligible: true },
    { id: 'd7', name: 'Catalog_AzRestMethodGet_IsOfficialReadEligible', cmd: native('az', [word('rest'), flag('--method'), word('get'), flag('--uri'), word('https://example.invalid/x')]), cls: 'read-remote', eligible: true },
    { id: 'd8', name: 'Catalog_AzRestMethodPostWithBody_IsNotOfficialReadEligible', cmd: native('az', [word('rest'), flag('--method'), word('post'), flag('--uri'), word('https://example.invalid/x'), flag('--body'), word('{}')]), cls: 'remote-write', eligible: false },
    { id: 'd9', name: 'Catalog_AwsDescribeInstances_IsOfficialReadEligible', cmd: native('aws', [word('ec2'), word('describe-instances')]), cls: 'read-remote', eligible: true },
    { id: 'd10', name: 'Catalog_AwsS3Ls_IsOfficialReadEligible', cmd: native('aws', [word('s3'), word('ls'), word('s3://bucket/prefix/')]), cls: 'unknown', eligible: true },
    { id: 'd11', name: 'Catalog_AwsS3Cp_IsDownloadNotOfficialRead', cmd: native('aws', [word('s3'), word('cp'), word('s3://bucket/key'), word('./key')]), cls: 'download', eligible: false },
    { id: 'd12', name: 'Catalog_KubectlGet_IsOfficialReadEligible', cmd: native('kubectl', [word('get'), word('pods'), flag('-n'), word('prod')]), cls: 'read-remote', eligible: true },
    { id: 'd13', name: 'Catalog_KubectlDelete_IsNotOfficialReadEligible', cmd: native('kubectl', [word('delete'), word('pod'), word('x')]), cls: 'remote-destructive', eligible: false },
    { id: 'd14', name: 'Catalog_InvokeRestMethodGet_IsRawHttpNotOfficialRead', cmd: cmdlet('invoke-restmethod', [word('https://api.github.com/repos/a/b')]), cls: 'read-remote', eligible: false },
    { id: 'd15', name: 'Catalog_CurlGet_IsRawHttpNotOfficialRead', cmd: native('curl', [word('https://example.invalid/x')]), cls: 'read-remote', eligible: false },
    { id: 'd16', name: 'Catalog_HsSearch_IsNotOfficialRead', cmd: native('hs', [word('search'), word('foo'), flag('--json')]), cls: 'read-remote', eligible: false },
];

for (const c of OFFICIAL_READ_CASES) {
    test(c.name, () => {
        // Arrange
        const cmd = c.cmd;

        // Act
        const result = cmd.inv === 'cmdlet' ? normalizeCmdlet(cmd, catalog.core) : classify(cmd);

        // Assert
        assert.equal(result.cls, c.cls, `spike ${c.id}: class`);
        assert.equal(officialReadEligible(result), c.eligible, `spike ${c.id}: official read eligibility`);
    });
}

// ---- review findings (fail-open paths) ----

test('Catalog_NpmPrefixAndPnpmDir_AreEffectiveCwdFlags', () => {
    // Arrange
    const npm = classify(native('npm', [flag('--prefix'), word('D:\\other'), word('test')]));
    const pnpmShort = classify(native('pnpm', [flag('-C'), word('D:\\other'), word('test')]));
    const pnpmLong = classify(native('pnpm', [flag('--dir'), word('D:\\other'), word('test')]));
    const dynamic = classify(native('npm', [flag('--prefix'), { k: 'word', raw: '$x', value: null, isConst: false }, word('test')]));

    // Act / Assert
    assert.equal(npm.repoCwd, 'D:\\other'); // C4
    assert.equal(pnpmShort.repoCwd, 'D:\\other');
    assert.equal(pnpmLong.repoCwd, 'D:\\other');
    assert.equal(dynamic.repoCwd, null);
});

test('Catalog_ReadNativeWithoutPaths_UsesEffectiveCwdAsImplicitReadPath', () => {
    // Arrange
    const plain = classify(native('rg', [word('x')]));
    const withC = classify(native('git', [flag('-C'), word('D:\\other'), word('log')]));

    // Act / Assert
    assert.deepEqual(plain.paths.map((p) => [p.full, p.kind, p.intent]), [[CWD, 'implicit', 'read']]); // C3
    assert.deepEqual(withC.paths.map((p) => [p.full, p.kind, p.intent]), [['D:\\other', 'implicit', 'read']]);
});

test('Catalog_ReadCmdletPositionalPathLikeWord_IsBoundAsReadPath', () => {
    // Arrange
    const hex = normalizeCmdlet(cmdlet('format-hex', [word('C:\\a\\b.bin')]), catalog.core);
    const sls = normalizeCmdlet(cmdlet('select-string', [word('x'), word('C:\\a\\b.txt')]), catalog.core);

    // Act / Assert
    assert.deepEqual(hex.paths.map((p) => [p.full, p.intent, p.dynamic]), [['C:\\a\\b.bin', 'read', false]]); // C2
    assert.deepEqual(sls.paths.map((p) => [p.full, p.intent]), [['C:\\a\\b.txt', 'read']]);
});

test('Catalog_PathTakingReadCmdletFedByPipeline_IsDynamicReadPath', () => {
    // Arrange
    const piped = normalizeCmdlet({ ...cmdlet('get-content', []), pipedFrom: true }, catalog.core);
    const fromPaths = normalizeCmdlet({ ...cmdlet('get-content', []), pipedFrom: true, pipeSource: 'paths' }, catalog.core);
    const fromData = normalizeCmdlet({ ...cmdlet('select-string', [word('foo')]), pipedFrom: true, pipeSource: 'data' }, catalog.core);
    const plain = normalizeCmdlet(cmdlet('get-childitem', []), catalog.core);
    const other = normalizeCmdlet({ ...cmdlet('select-object', [word('Name')]), pipedFrom: true }, catalog.core);

    // Act / Assert
    assert.deepEqual(piped.paths.map((p) => [p.dynamic, p.intent]), [[true, 'read']]); // C2: unknown upstream stays conservative
    assert.deepEqual(fromPaths.paths.map((p) => [p.dynamic, p.intent]), [[true, 'read']]);
    assert.deepEqual(fromData.paths, []); // follow-up 2: upstream emits text, not paths
    assert.deepEqual(plain.paths.map((p) => [p.full, p.kind]), [[CWD, 'implicit']]); // C3
    assert.deepEqual(other.paths.map((p) => [p.full, p.kind]), [[CWD, 'implicit']]);
});

test('Catalog_WriteHostPathLikeString_IsNotAPathAndSetLocationHasNoImplicitPath', () => {
    // Arrange
    const host = normalizeCmdlet(cmdlet('write-host', [word('C:\\Windows\\foo')]), catalog.core);
    const cd = normalizeCmdlet(cmdlet('set-location', []), catalog.core);

    // Act / Assert
    assert.ok(host.paths.every((p) => p.kind === 'implicit'), JSON.stringify(host.paths)); // A8
    assert.deepEqual(cd.paths, []);
});

test('Catalog_InjectedResolve_IsUsedForNativeAndCmdletPaths', () => {
    // Arrange
    const resolve = (v) => (v.startsWith('~') ? `Z:\\home${v.slice(1)}` : v);
    const nativeResult = normalizeNative(native('rg', [word('x'), word('~\\a\\b')]), toolSpec('rg'), { resolve });
    const cmdletResult = normalizeCmdlet(cmdlet('get-content', [{ ...word('~\\a\\b'), pathParam: true }]), catalog.core, { resolve });

    // Act / Assert
    assert.deepEqual(nativeResult.paths.map((p) => p.full), ['Z:\\home\\a\\b']); // W6
    assert.deepEqual(cmdletResult.paths.map((p) => p.full), ['Z:\\home\\a\\b']);
});

test('Catalog_SqlFileCarrier_ReadsOnlyFromConfiguredRoots', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'catalog-sql-'));
    const file = join(dir, 'q.sql');
    writeFileSync(file, 'insert into t values (1)');
    const cmd = native('snow', [word('sql'), flag('-f'), word(file)]);

    try {
        // Act
        const allowed = normalizeNative(cmd, toolSpec('snow'), { sqlFileRoots: [dir] });
        const denied = normalizeNative(cmd, toolSpec('snow'), { sqlFileRoots: [join(dir, 'other')] });
        const none = normalizeNative(cmd, toolSpec('snow'), {});

        // Assert
        assert.equal(allowed.cls, 'remote-write'); // W6: the file body was classified
        assert.equal(denied.sqlInfo.kind, 'unresolved');
        assert.equal(none.sqlInfo.kind, 'unresolved');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---- delta review (pipelines, recursive reads, providers) ----

test('Catalog_GetContentFedByTextPipeline_IsStillDynamicReadPath', () => {
    // Arrange
    const fromData = normalizeCmdlet({ ...cmdlet('get-content', []), pipedFrom: true, pipeSource: 'data' }, catalog.core);
    const alias = normalizeCmdlet({ ...cmdlet('import-csv', []), pipedFrom: true, pipeSource: 'data' }, catalog.core);

    // Act / Assert
    assert.deepEqual(fromData.paths.map((p) => [p.dynamic, p.intent]), [[true, 'read']]); // N1: only Select-String has the text exemption
    assert.deepEqual(alias.paths.map((p) => [p.dynamic, p.intent]), [[true, 'read']]);
});

test('Catalog_RecursiveNativeReads_AreMarkedIgnoreAwareOrBypass', () => {
    // Arrange
    const cases = [
        ['rg', [word('x')], 'ignore-aware'],
        ['rg', [flag('-uu'), word('x')], 'bypass'],
        ['rg', [flag('--hidden'), word('x')], 'bypass'],
        ['rg', [flag('--no-ignore-vcs'), word('x')], 'bypass'],
        ['fd', [word('x')], 'ignore-aware'],
        ['fd', [flag('-H'), word('x')], 'bypass'],
        ['grep', [word('x'), word('f.txt')], null],
        ['grep', [flag('-r'), word('x'), word('.')], 'bypass'],
        ['grep', [flag('-rn'), word('x'), word('.')], 'bypass'],
        ['findstr', [word('/s'), word('x'), word('*')], 'bypass'],
        ['findstr', [word('x'), word('f.txt')], null],
    ];

    // Act / Assert
    for (const [name, args, expected] of cases) {
        assert.equal(classify(native(name, args)).recursive, expected, `${name} ${args.map((a) => a.raw).join(' ')}`);
    }
});

test('Catalog_RgAndFdFollowFlags_AreBypass', () => { // TFIX-5 item 5: following symlinks leaves the analysed tree
    // Arrange
    const cases = [
        ['rg', [flag('-L'), word('x')], 'bypass'],
        ['rg', [flag('--follow'), word('x')], 'bypass'],
        ['fd', [flag('-L'), word('x')], 'bypass'],
        ['fd', [flag('--follow'), word('x')], 'bypass'],
        ['rg', [word('x')], 'ignore-aware'],
        ['fd', [word('x')], 'ignore-aware'],
    ];

    // Act / Assert
    for (const [name, args, expected] of cases) {
        assert.equal(classify(native(name, args)).recursive, expected, `${name} ${args.map((a) => a.raw).join(' ')}`);
    }
});

test('Catalog_RecursiveCmdlets_AreMarked', () => {
    // Arrange
    const plain = normalizeCmdlet(cmdlet('get-childitem', []), catalog.core);
    const recurse = normalizeCmdlet(cmdlet('get-childitem', [flag('-Recurse')]), catalog.core);
    const force = normalizeCmdlet(cmdlet('get-childitem', [flag('-Recurse'), flag('-Force')]), catalog.core);
    const partial = normalizeCmdlet(cmdlet('get-childitem', [flag('-Rec')]), catalog.core);
    const sls = normalizeCmdlet(cmdlet('select-string', [flag('-Recurse'), word('x')]), catalog.core);

    // Act / Assert
    assert.equal(plain.recursive, null);
    assert.equal(recurse.recursive, 'ignore-aware');
    assert.equal(force.recursive, 'bypass');
    assert.equal(partial.recursive, 'ignore-aware');
    assert.equal(sls.recursive, 'bypass');
});

test('Catalog_AliasCmdlets_AreUnknown', () => {
    // Arrange
    const set = normalizeCmdlet(cmdlet('set-alias', [word('ls'), word('Remove-Item')]), catalog.core);
    const created = normalizeCmdlet(cmdlet('new-alias', [word('ls'), word('Remove-Item')]), catalog.core);

    // Act / Assert
    assert.equal(set.cls, 'unknown'); // N4
    assert.equal(created.cls, 'unknown');
});

test('Catalog_NewObjectProcessTypes_AreUnknown', () => {
    // Arrange
    const process = normalizeCmdlet(cmdlet('new-object', [word('System.Diagnostics.Process')]), catalog.core);
    const info = normalizeCmdlet(cmdlet('new-object', [word('System.Diagnostics.ProcessStartInfo')]), catalog.core);

    // Act / Assert
    assert.equal(process.cls, 'unknown'); // N3
    assert.equal(info.cls, 'unknown');
});