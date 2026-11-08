import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifestPath = resolve(process.cwd(), 'android/app/src/main/AndroidManifest.xml');

let manifest;
try {
  manifest = await readFile(manifestPath, 'utf8');
} catch {
  console.log('Android project not present; camera permission patch skipped.');
  process.exit(0);
}

if (!/<manifest\b/.test(manifest)) {
  throw new Error('AndroidManifest.xml is missing its <manifest> root element.');
}

if (!/android\.permission\.CAMERA/.test(manifest)) {
  manifest = manifest.replace(
    /(<manifest\b[^>]*>)/,
    '$1\n    <uses-permission android:name="android.permission.CAMERA" />'
  );
  await writeFile(manifestPath, manifest, 'utf8');
  console.log('Added CAMERA permission to AndroidManifest.xml.');
} else {
  console.log('CAMERA permission already exists in AndroidManifest.xml.');
}
