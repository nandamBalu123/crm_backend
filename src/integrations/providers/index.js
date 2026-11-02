'use strict';

const { z } = require('zod');
const env = require('../../config/env');
const { safeFetch, assertPublicHost } = require('../../utils/safeFetch');
const { sign } = require('../aws/sigv4');

/**
 * Integration provider adapters. Each adapter declares:
 *   key, name, category, description, auth ('api_key'|'oauth2'|'smtp'|'inbound')
 *   configSchema (non-secret settings) and secretSchema (encrypted at rest)
 *   envVars: platform-level variables the adapter needs (OAuth apps)
 *   capabilities: what the CRM can do through it
 *   test({ config, secrets }) → { ok, message } — a REAL call to the provider
 *   optional actions: sendEmail, sendSms, sendWhatsApp, postMessage
 * Adapters never report success without the provider confirming it.
 */
const str = (max = 255) => z.string().trim().min(1).max(max);
const email = () => z.string().trim().email().max(254);

async function jsonOrText(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function fail(res, body) {
  const msg = body?.message || body?.error?.message || body?.errors?.[0]?.message || body?.error_description || body?.error || body?.raw || `HTTP ${res.status}`;
  return { ok: false, message: `Provider responded ${res.status}: ${String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300)}` };
}

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

const providers = {
  smtp: {
    name: 'SMTP', category: 'email', auth: 'smtp', capabilities: ['email.send'],
    description: 'Send CRM emails through any SMTP server.',
    configSchema: z.strictObject({ host: str(253), port: z.coerce.number().int().min(1).max(65535), secure: z.boolean().default(false), from_email: email(), from_name: str(120).optional() }),
    secretSchema: z.strictObject({ username: str(254).optional(), password: str(500).optional() }),
    transporter({ config, secrets }) {
      const nodemailer = require('nodemailer');
      return nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, auth: secrets.username ? { user: secrets.username, pass: secrets.password } : undefined, connectionTimeout: 10_000, greetingTimeout: 10_000 });
    },
    async test(conn) {
      await assertPublicHost(conn.config.host);
      try {
        await this.transporter(conn).verify();
        return { ok: true, message: 'SMTP server accepted the connection and credentials' };
      } catch (err) {
        return { ok: false, message: `SMTP verification failed: ${err.message}` };
      }
    },
    async sendEmail(conn, msg) {
      await assertPublicHost(conn.config.host);
      const info = await this.transporter(conn).sendMail({ from: { name: conn.config.from_name || '', address: conn.config.from_email }, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers });
      return { provider_message_id: info.messageId };
    },
  },
  amazon_ses: {
    name: 'Amazon SES (SMTP)', category: 'email', auth: 'smtp', capabilities: ['email.send'],
    description: 'Amazon SES via its SMTP interface. Create SMTP credentials in the SES console.',
    configSchema: z.strictObject({ region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/), from_email: email(), from_name: str(120).optional() }),
    secretSchema: z.strictObject({ smtp_username: str(200), smtp_password: str(500) }),
    smtp(conn) {
      return { config: { host: `email-smtp.${conn.config.region}.amazonaws.com`, port: 587, secure: false, from_email: conn.config.from_email, from_name: conn.config.from_name }, secrets: { username: conn.secrets.smtp_username, password: conn.secrets.smtp_password } };
    },
    test(conn) { return providers.smtp.test(this.smtp(conn)); },
    sendEmail(conn, msg) { return providers.smtp.sendEmail(this.smtp(conn), msg); },
  },
  sendgrid: {
    name: 'SendGrid', category: 'email', auth: 'api_key', capabilities: ['email.send'],
    description: 'Transactional and marketing email via the SendGrid v3 API.',
    configSchema: z.strictObject({ from_email: email(), from_name: str(120).optional() }),
    secretSchema: z.strictObject({ api_key: z.string().regex(/^SG\.[\w-]+\.[\w-]+$/, 'SendGrid keys start with SG.') }),
    async test({ secrets }) {
      const res = await safeFetch('https://api.sendgrid.com/v3/scopes', { headers: { Authorization: `Bearer ${secrets.api_key}` } });
      const body = await jsonOrText(res);
      if (!res.ok) return fail(res, body);
      const canSend = (body.scopes || []).includes('mail.send');
      return { ok: canSend, message: canSend ? 'API key valid with mail.send scope' : 'API key is valid but lacks the mail.send scope' };
    },
    async sendEmail({ config, secrets }, msg) {
      const res = await safeFetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST', headers: { Authorization: `Bearer ${secrets.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ personalizations: [{ to: [{ email: msg.to }] }], from: { email: config.from_email, name: config.from_name }, subject: msg.subject, content: [{ type: 'text/plain', value: msg.text || ' ' }, { type: 'text/html', value: msg.html }], headers: msg.headers }),
      });
      if (!res.ok) throw new Error(fail(res, await jsonOrText(res)).message);
      return { provider_message_id: res.headers.get('x-message-id') };
    },
  },
  mailgun: {
    name: 'Mailgun', category: 'email', auth: 'api_key', capabilities: ['email.send'],
    description: 'Email delivery via the Mailgun API.',
    configSchema: z.strictObject({ domain: str(253), region: z.enum(['us', 'eu']).default('us'), from_email: email(), from_name: str(120).optional() }),
    secretSchema: z.strictObject({ api_key: str(200) }),
    base: (config) => (config.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'),
    async test({ config, secrets }) {
      const res = await safeFetch(`${this.base(config)}/v3/domains/${encodeURIComponent(config.domain)}`, { headers: { Authorization: basic('api', secrets.api_key) } });
      const body = await jsonOrText(res);
      if (!res.ok) return fail(res, body);
      return { ok: true, message: `Domain ${config.domain} is ${body.domain?.state || 'reachable'}` };
    },
    async sendEmail({ config, secrets }, msg) {
      const form = new URLSearchParams({ from: config.from_name ? `${config.from_name} <${config.from_email}>` : config.from_email, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text || '' });
      const res = await safeFetch(`${this.base(config)}/v3/${encodeURIComponent(config.domain)}/messages`, { method: 'POST', headers: { Authorization: basic('api', secrets.api_key), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
      const body = await jsonOrText(res);
      if (!res.ok) throw new Error(fail(res, body).message);
      return { provider_message_id: body.id };
    },
  },
  twilio: {
    name: 'Twilio SMS', category: 'messaging', auth: 'api_key', capabilities: ['sms.send', 'whatsapp.send'],
    description: 'SMS (and WhatsApp via Twilio) messaging.',
    configSchema: z.strictObject({ account_sid: z.string().regex(/^AC[0-9a-fA-F]{32}$/, 'Account SID starts with AC'), from_number: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 number, e.g. +15551234567'), whatsapp_from: z.string().regex(/^\+[1-9]\d{6,14}$/).optional() }),
    secretSchema: z.strictObject({ auth_token: str(100) }),
    async test({ config, secrets }) {
      const res = await safeFetch(`https://api.twilio.com/2010-04-01/Accounts/${config.account_sid}.json`, { headers: { Authorization: basic(config.account_sid, secrets.auth_token) } });
      const body = await jsonOrText(res);
      if (!res.ok) return fail(res, body);
      return { ok: body.status === 'active', message: `Twilio account "${body.friendly_name}" is ${body.status}` };
    },
    async send({ config, secrets }, to, from, text) {
      const res = await safeFetch(`https://api.twilio.com/2010-04-01/Accounts/${config.account_sid}/Messages.json`, {
        method: 'POST', headers: { Authorization: basic(config.account_sid, secrets.auth_token), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: text }).toString(),
      });
      const body = await jsonOrText(res);
      if (!res.ok) throw new Error(fail(res, body).message);
      return { provider_message_id: body.sid };
    },
    sendSms(conn, msg) { return this.send(conn, msg.to, conn.config.from_number, msg.text); },
    sendWhatsApp(conn, msg) {
      if (!conn.config.whatsapp_from) throw new Error('Configure a WhatsApp sender number first');
      return this.send(conn, `whatsapp:${msg.to}`, `whatsapp:${conn.config.whatsapp_from}`, msg.text);
    },
  },
  whatsapp_cloud: {
    name: 'WhatsApp Business (Meta Cloud API)', category: 'messaging', auth: 'api_key', capabilities: ['whatsapp.send'],
    description: 'WhatsApp Business Platform. Messages outside the 24h window require approved templates.',
    configSchema: z.strictObject({ phone_number_id: z.string().regex(/^\d{5,30}$/), api_version: z.string().regex(/^v\d+\.\d+$/).default('v21.0') }),
    secretSchema: z.strictObject({ access_token: str(1000) }),
    async test({ config, secrets }) {
      const res = await safeFetch(`https://graph.facebook.com/${config.api_version}/${config.phone_number_id}`, { headers: { Authorization: `Bearer ${secrets.access_token}` } });
      const body = await jsonOrText(res);
      if (!res.ok) return fail(res, body);
      return { ok: true, message: `Phone number ${body.display_phone_number || config.phone_number_id} is reachable` };
    },
    async sendWhatsApp({ config, secrets }, msg) {
      const res = await safeFetch(`https://graph.facebook.com/${config.api_version}/${config.phone_number_id}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${secrets.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.to.replace(/^\+/, ''), type: 'text', text: { body: msg.text } }),
      });
      const body = await jsonOrText(res);
      if (!res.ok) throw new Error(fail(res, body).message);
      return { provider_message_id: body.messages?.[0]?.id };
    },
  },
  slack: {
    name: 'Slack', category: 'collaboration', auth: 'api_key', capabilities: ['chat.post'],
    description: 'Post CRM notifications to a Slack channel using a bot token.',
    configSchema: z.strictObject({ default_channel: z.string().regex(/^[#@]?[\w-]{1,80}$|^[CGD][A-Z0-9]{6,}$/) }),
    secretSchema: z.strictObject({ bot_token: z.string().regex(/^xoxb-/, 'Bot tokens start with xoxb-') }),
    async call(secrets, method, payload) {
      const res = await safeFetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${secrets.bot_token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload || {}) });
      return jsonOrText(res);
    },
    async test({ secrets }) {
      const body = await this.call(secrets, 'auth.test');
      return body.ok ? { ok: true, message: `Connected to workspace ${body.team} as ${body.user}` } : { ok: false, message: `Slack error: ${body.error}` };
    },
    async postMessage({ config, secrets }, { channel, text }) {
      const body = await this.call(secrets, 'chat.postMessage', { channel: channel || config.default_channel, text });
      if (!body.ok) throw new Error(`Slack error: ${body.error}`);
      return { provider_message_id: body.ts };
    },
  },
  zoom: {
    name: 'Zoom', category: 'meetings', auth: 'api_key', capabilities: ['meetings.create'],
    description: 'Zoom Server-to-Server OAuth app (account credentials).',
    configSchema: z.strictObject({ account_id: str(100) }),
    secretSchema: z.strictObject({ client_id: str(100), client_secret: str(200) }),
    async token({ config, secrets }) {
      const res = await safeFetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(config.account_id)}`, { method: 'POST', headers: { Authorization: basic(secrets.client_id, secrets.client_secret) } });
      return { res, body: await jsonOrText(res) };
    },
    async test(conn) {
      const { res, body } = await this.token(conn);
      if (!res.ok) return fail(res, body);
      return { ok: true, message: `Zoom token issued (scopes: ${String(body.scope || '').slice(0, 120)})` };
    },
  },
  google_workspace: {
    name: 'Google Workspace (Gmail & Calendar)', category: 'productivity', auth: 'oauth2', capabilities: ['email.sync', 'calendar.sync'],
    description: 'Connect a Google account for Gmail and Google Calendar. Requires the platform Google OAuth app.',
    envVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    configSchema: z.strictObject({}), secretSchema: z.strictObject({}),
    oauth: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.send'],
      clientId: () => env.GOOGLE_CLIENT_ID, clientSecret: () => env.GOOGLE_CLIENT_SECRET, extra: { access_type: 'offline', prompt: 'consent' },
    },
    async test({ secrets }) {
      if (!secrets.access_token) return { ok: false, message: 'Not connected — complete the Google sign-in first' };
      const res = await safeFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${secrets.access_token}` } });
      const body = await jsonOrText(res);
      return res.ok ? { ok: true, message: `Connected as ${body.email}` } : fail(res, body);
    },
  },
  microsoft_365: {
    name: 'Microsoft 365 (Outlook mail & calendar)', category: 'productivity', auth: 'oauth2', capabilities: ['email.sync', 'calendar.sync'],
    description: 'Connect a Microsoft 365 account. Requires the platform Microsoft Entra app registration.',
    envVars: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    configSchema: z.strictObject({}), secretSchema: z.strictObject({}),
    oauth: {
      authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['offline_access', 'User.Read', 'Mail.Send', 'Calendars.ReadWrite'],
      clientId: () => env.MICROSOFT_CLIENT_ID, clientSecret: () => env.MICROSOFT_CLIENT_SECRET, extra: {},
    },
    async test({ secrets }) {
      if (!secrets.access_token) return { ok: false, message: 'Not connected — complete the Microsoft sign-in first' };
      const res = await safeFetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${secrets.access_token}` } });
      const body = await jsonOrText(res);
      return res.ok ? { ok: true, message: `Connected as ${body.userPrincipalName}` } : fail(res, body);
    },
  },
  stripe: {
    name: 'Stripe', category: 'payments', auth: 'api_key', capabilities: ['payments.read'],
    description: 'Connect your Stripe account (restricted key recommended).',
    configSchema: z.strictObject({}),
    secretSchema: z.strictObject({ secret_key: z.string().regex(/^(sk|rk)_(test|live)_[\w]+$/, 'Use a secret (sk_) or restricted (rk_) key') }),
    async test({ secrets }) {
      const res = await safeFetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${secrets.secret_key}` } });
      const body = await jsonOrText(res);
      return res.ok ? { ok: true, message: `Stripe ${body.livemode ? 'live' : 'test'} mode account reachable` } : fail(res, body);
    },
  },
  razorpay: {
    name: 'Razorpay', category: 'payments', auth: 'api_key', capabilities: ['payments.read'],
    description: 'Connect your Razorpay account.',
    configSchema: z.strictObject({}),
    secretSchema: z.strictObject({ key_id: z.string().regex(/^rzp_(test|live)_\w+$/), key_secret: str(100) }),
    async test({ secrets }) {
      const res = await safeFetch('https://api.razorpay.com/v1/payments?count=1', { headers: { Authorization: basic(secrets.key_id, secrets.key_secret) } });
      const body = await jsonOrText(res);
      return res.ok ? { ok: true, message: 'Razorpay credentials accepted' } : fail(res, body);
    },
  },
  s3: {
    name: 'S3-compatible storage', category: 'storage', auth: 'api_key', capabilities: ['files.store'],
    description: 'Amazon S3, MinIO, Cloudflare R2, Wasabi… (connection test only; the platform storage driver is configured via environment).',
    configSchema: z.strictObject({ endpoint: z.string().url().max(500), bucket: z.string().regex(/^[a-z0-9.-]{3,63}$/), region: str(40) }),
    secretSchema: z.strictObject({ access_key_id: str(128), secret_access_key: str(256) }),
    async test({ config, secrets }) {
      const url = `${config.endpoint.replace(/\/$/, '')}/${config.bucket}`;
      const headers = sign({ method: 'HEAD', url, region: config.region, accessKeyId: secrets.access_key_id, secretAccessKey: secrets.secret_access_key, body: '' });
      const res = await safeFetch(url, { method: 'HEAD', headers });
      return res.ok ? { ok: true, message: `Bucket ${config.bucket} is accessible` } : { ok: false, message: `Bucket check failed with HTTP ${res.status}` };
    },
  },
  inbound_leads: {
    name: 'External lead sources (inbound webhook)', category: 'lead_capture', auth: 'inbound', capabilities: ['leads.inbound'],
    description: 'Receive leads from landing-page builders, ad platforms or Zapier via a signed webhook URL.',
    configSchema: z.strictObject({ lead_source: str(60).default('inbound_webhook'), field_map: z.record(z.string().max(80), z.string().max(80)).default({}), default_owner_id: z.string().uuid().optional() }),
    secretSchema: z.strictObject({ signing_secret: z.string().min(24).max(200).optional() }),
    async test() { return { ok: true, message: 'Inbound endpoint is active. Send a signed test request to verify your sender.' }; },
  },
};

for (const [key, p] of Object.entries(providers)) p.key = key;

function oauthAvailable(p) {
  return !p.oauth || !!(p.oauth.clientId() && p.oauth.clientSecret());
}

function catalog() {
  return Object.values(providers).map((p) => ({
    key: p.key, name: p.name, category: p.category, description: p.description, auth: p.auth, capabilities: p.capabilities,
    env_vars: p.envVars || [], platform_ready: oauthAvailable(p),
    config_schema: z.toJSONSchema(p.configSchema, { io: 'input', unrepresentable: 'any' }),
    secret_fields: Object.keys(p.secretSchema.shape || {}),
  }));
}

module.exports = { providers, catalog, oauthAvailable };
