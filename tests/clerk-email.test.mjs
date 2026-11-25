import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Webhook } from 'svix';
import handler from '../api/clerk-email.js';

test('Clerk email webhook verifies the signature before forwarding a message once per signing event', async (t) => {
  const secret = 'whsec_' + Buffer.alloc(32, 1).toString('base64');
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = secret;
  process.env.RESEND_API_KEY = 'local-test';
  process.env.RESEND_FROM_EMAIL = 'Login <login@example.test>';
  const body = JSON.stringify({type:'email.created',data:{id:'ema_test',to_email_address:'user@example.test',subject:'Verification',body:'<p>Code</p>'}});
  const time = new Date();
  const send = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.headers['Idempotency-Key'], 'clerk-email/ema_test');
    assert.equal(JSON.parse(options.body).to[0], 'user@example.test');
    return {ok:true};
  });
  for (const signed of [false, true]) {
    const req = Readable.from([Buffer.from(body)]);
    req.method = 'POST';
    req.headers = {
      'svix-id': 'msg_test',
      'svix-timestamp': String(Math.floor(time.getTime() / 1000)),
      'svix-signature': signed ? new Webhook(secret).sign('msg_test', time, body) : 'v1,bad',
    };
    const res = {setHeader(){}, status(code){this.code=code;return this;}, end(){}};
    await handler(req, res);
    assert.equal(res.code, signed ? 204 : 400);
  }
  assert.equal(send.mock.callCount(), 1);
});
