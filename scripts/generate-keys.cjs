const { generateVAPIDKeys } = require('web-push');
const { randomBytes } = require('node:crypto');
const keys = generateVAPIDKeys();
console.log('Salin nilai berikut ke Environment Variables Vercel. Jangan unggah ke GitHub.\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('CRON_SECRET=' + randomBytes(32).toString('hex'));
console.log('\nBuat satu kali. Jangan mengganti pasangan VAPID setelah HP terdaftar.');
