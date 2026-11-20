import { build } from 'esbuild';

/**
 * 把 server/ 与它复用的 src/ 纯逻辑（engine / types / bank / words / hex）
 * 打成一个 Node ESM 单文件。node_modules 里的依赖保持 external，
 * 运行时由 npm install 装好的包提供。
 */
await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist-server/index.mjs',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});
