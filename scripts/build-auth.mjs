import { build } from 'esbuild';
await build({ stdin: { contents: "export { Clerk } from '@clerk/clerk-js';", resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, outfile: 'assets/vendor/clerk.js', legalComments: 'eof' });
await build({ stdin: { contents: "export { default } from 'jsqr';", resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'browser', minify: true, outfile: 'assets/vendor/jsqr.js', legalComments: 'eof' });
