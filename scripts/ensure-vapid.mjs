import webpush from 'web-push';
import { appendFile, readFile } from 'node:fs/promises';

const envPath = process.argv[2] || '.env';
const content = await readFile(envPath, 'utf8').catch(() => '');
const hasPublicKey = /^VAPID_PUBLIC_KEY=.+$/m.test(content);
const hasPrivateKey = /^VAPID_PRIVATE_KEY=.+$/m.test(content);

if (hasPublicKey !== hasPrivateKey) {
  throw new Error('VAPID configuration is incomplete. Remove the existing VAPID line and run this script again.');
}

if (hasPublicKey && hasPrivateKey) {
  console.log('Web Push keys are already configured.');
  process.exit(0);
}

const keys = webpush.generateVAPIDKeys();
const prefix = content && !content.endsWith('\n') ? '\n' : '';
const subject = /^VAPID_SUBJECT=.+$/m.test(content) ? '' : 'VAPID_SUBJECT=mailto:ivanlindgren@yandex.ru\n';
await appendFile(
  envPath,
  `${prefix}${subject}VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`,
  { encoding: 'utf8', mode: 0o600 },
);
console.log('Web Push keys were generated and saved without printing them.');
