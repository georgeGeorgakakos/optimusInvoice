import esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Bundle the server for Electron
esbuild.build({
  entryPoints: [resolve(__dirname, 'server/_core/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist-server/index.js',
  external: [
    // Keep these as external dependencies
    'better-sqlite3',
    'mysql2',
    '@aws-sdk/*',
    'lightningcss',
    '@babel/*',
    'esbuild',
    'vite',
    'drizzle-orm',
    'drizzle-kit',
  ],
  loader: {
    '.node': 'file',
  },
  banner: {
    js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`,
  },
}).then(() => {
  console.log('✅ Server bundled successfully for Electron');
}).catch((error) => {
  console.error('❌ Server bundle failed:', error);
  process.exit(1);
});
