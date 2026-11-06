// 用 Cortico 自带的 dry-mount 检查扩展声明（不调用 start，不进真实部署）。
// 运行方式见 ../README.md「本地校验」。
// 应用目录默认取本机安装位置；换机器时设 COOPANION_APP 环境变量。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = (process.env.COOPANION_APP ?? 'D:/Coopanion-Setup-0.2.8/resources/app').replace(/\\/g, '/').replace(/\/+$/, '');
const { dryMountWorld } = await import(pathToFileURL(`${app}/build/cortico/src/extensions/dry-mount.ts`).href);
const { parseExtensionManifest } = await import(pathToFileURL(`${app}/build/cortico/src/extensions/manifest.ts`).href);

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
const manifest = parseExtensionManifest(pkg, 'zh');
console.log('manifest:', JSON.stringify(manifest, null, 2));
if (!manifest.ok) process.exit(1);

const plugin = (await import(new URL('../src/index.ts', import.meta.url).href)).default;
const report = await dryMountWorld(plugin, {
  scratchDir: mkdtempSync(join(tmpdir(), 'threads-dry-')),
  packageDir: root,
  hasWebUiClient: true,
  language: 'zh',
});
console.log('dry-mount:', JSON.stringify(report, null, 2));
if (report.failures.length) process.exit(1);
