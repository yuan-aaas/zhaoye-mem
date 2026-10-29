// 包名解析由 tsconfig.arch.json 的 paths 指向各包 src，避免 dist 被排除后规则只看到裸包名。
// T0 阶段插件规则对 node_modules 全放开；选定真实宿主 SDK 后收紧为按插件白名单（DEVELOPMENT-DESIGN §2.3）。
const packageNames = ['contracts', 'storage', 'core', 'app', 'adapter-kit', 'cli'];
const pluginNames = ['dsh', 'mcp'];
const packageRoots = [
  ...packageNames.map((name) => `packages/${name}`),
  ...pluginNames.map((name) => `plugins/${name}`),
];

const zodModulePaths = [
  'node_modules/zod/',
  String.raw`node_modules/\.pnpm/zod@[0-9a-zA-Z._+-]+/node_modules/zod/`,
].join('|');

const forbidden = [
  {
    name: 'contracts-pure',
    severity: 'error',
    from: { path: '^packages/contracts/src/' },
    to: { pathNot: `^(packages/contracts/src/|${zodModulePaths})` },
  },
  {
    name: 'storage-no-domain',
    severity: 'error',
    from: { path: '^packages/storage/src/' },
    to: { path: '^packages/(core|app|adapter-kit|cli)/|^plugins/' },
  },
  {
    name: 'core-no-fs',
    severity: 'error',
    from: { path: '^packages/core/src/' },
    to: { path: '^(node:)?(fs|path|os|child_process)(/|$)' },
  },
  {
    name: 'core-no-upper',
    severity: 'error',
    from: { path: '^packages/core/src/' },
    to: { path: '^packages/(app|adapter-kit|cli)/|^plugins/' },
  },
  {
    name: 'app-no-adapters',
    severity: 'error',
    from: { path: '^packages/app/src/' },
    to: { path: '^packages/(adapter-kit|cli)/|^plugins/' },
  },
  {
    name: 'kit-pure',
    severity: 'error',
    from: { path: '^packages/adapter-kit/src/' },
    to: { pathNot: '^packages/contracts/' },
  },
  {
    name: 'no-circular',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
];

for (const pluginName of pluginNames) {
  forbidden.push({
    name: `plugin-public-only-${pluginName}`,
    severity: 'error',
    from: { path: `^plugins/${pluginName}/src/` },
    to: {
      pathNot: `^(plugins/${pluginName}/|packages/(app|adapter-kit|contracts)/|node_modules/|node:)`,
      dependencyTypesNot: ['core'],
    },
  });
}

for (const consumerRoot of packageRoots) {
  for (const providerRoot of packageRoots) {
    if (consumerRoot === providerRoot) continue;
    forbidden.push({
      name: `no-cross-internal-${consumerRoot.replaceAll('/', '-')}-${providerRoot.replaceAll('/', '-')}`,
      severity: 'error',
      from: { path: `^${consumerRoot}/src/` },
      to: { path: `^${providerRoot}/(src|dist)/internal/` },
    });
  }
}

module.exports = {
  forbidden,
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: '(^|/)(test|dist|dist-test)/',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.arch.json' },
  },
};
