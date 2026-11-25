import { Webhook } from 'svix';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).end();
  }

  const { CLERK_WEBHOOK_SIGNING_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL } = process.env;
  if (!CLERK_WEBHOOK_SIGNING_SECRET || !RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    return response.status(503).end('Email delivery is not configured');
  }

  let event;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 256 * 1024) return response.status(413).end();
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    await new Webhook(CLERK_WEBHOOK_SIGNING_SECRET).verify(body, request.headers);
    event = JSON.parse(body);
  } catch {
    return response.status(400).end('Invalid webhook');
  }

  if (event?.type !== 'email.created' || event.data?.delivered_by_clerk === true) {
    return response.status(204).end();
  }
  const { id, to_email_address: to, subject, body: html, body_plain: plain } = event.data || {};
  if (![id, to, subject, html].every((value) => typeof value === 'string' && value.trim())) {
    return response.status(422).end('Invalid email event');
  }

  try {
    const result = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'clerk-email/' + id,
      },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [to], subject, html, text: plain || undefined }),
      signal: AbortSignal.timeout(10000),
    });
    if (!result.ok) {
      console.error('Resend returned HTTP', result.status);
      return response.status(502).end('Email delivery failed');
    }
    return response.status(204).end();
  } catch {
    return response.status(502).end('Email delivery failed');
  }
}
