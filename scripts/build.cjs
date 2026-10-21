const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'public'), out, { recursive: true });
for (const filename of ['index.html', 'ruang-novena.html']) {
  fs.copyFileSync(path.join(root, 'ruang-novena.html'), path.join(out, filename));
}
console.log('Halaman, ikon iPhone, dan service worker siap di dist/.');
