import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'config.js', 'assets', 'admin']) {
  await cp(file, `dist/${file}`, { recursive: true });
}
