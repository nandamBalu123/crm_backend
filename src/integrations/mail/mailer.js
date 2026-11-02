'use strict';

const env = require('../../config/env');
const { EmailOutbox } = require('../../models');
const queue = require('../../jobs/queue');
const { encryptJson, decryptJson } = require('../../utils/crypto');
const { logger } = require('../../logging/logger');
const { getContext } = require('../../context/requestContext');

/**
 * Platform mail delivery (account emails: verification, password reset,
 * invitations, notifications). Message content is encrypted inside the job
 * payload because it can contain one-time links. Tenant CRM emails to
 * customers go through modules/communications (tenant-configured provider).
 *
 * MAIL_TRANSPORT:
 *   smtp     – nodemailer SMTP (SMTP_HOST etc. required)
 *   log      – development: logs the message (including links) to the API console
 *   disabled – records the message as skipped
 */
let transporter;
const captured = []; // test-only inspection

function getTransporter() {
  if (transporter) return transporter;
  if (env.MAIL_TRANSPORT !== 'smtp') return null;
  if (!env.SMTP_HOST) throw Object.assign(new Error('SMTP_HOST is not configured'), { permanent: true });
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT || 587,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return transporter;
}

async function queueEmail({ to, subject, html, text, templateKey }, { transaction, tenantId } = {}) {
  const ctx = getContext() || {};
  const tid = tenantId !== undefined ? tenantId : ctx.tenantId || null;
  const outbox = await EmailOutbox.create({ tenant_id: tid, to_email: to, subject, template_key: templateKey || null }, { transaction });
  await queue.enqueue('email.send', { outbox_id: outbox.id, message: encryptJson({ to, subject, html, text }) }, { transaction, tenantId: null, maxAttempts: 6 });
  return outbox;
}

async function deliver({ outbox_id: outboxId, message }) {
  const msg = decryptJson(message);
  const outbox = await EmailOutbox.findByPk(outboxId);
  if (!outbox) return { skipped: 'outbox missing' };
  outbox.attempts += 1;
  try {
    if (env.MAIL_TRANSPORT === 'disabled') {
      Object.assign(outbox, { status: 'skipped', last_error: 'MAIL_TRANSPORT=disabled' });
    } else if (env.MAIL_TRANSPORT === 'log') {
      if (env.isTest) captured.push(msg);
      else logger.info({ to: msg.to, subject: msg.subject, text: msg.text }, 'email (MAIL_TRANSPORT=log, development only)');
      Object.assign(outbox, { status: 'sent', provider: 'log', sent_at: new Date() });
    } else {
      const info = await getTransporter().sendMail({ from: env.MAIL_FROM, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
      Object.assign(outbox, { status: 'sent', provider: 'smtp', provider_message_id: info.messageId, sent_at: new Date(), last_error: null });
    }
    await outbox.save();
    return { status: outbox.status };
  } catch (err) {
    outbox.status = 'failed';
    outbox.last_error = String(err.message).slice(0, 1000);
    await outbox.save();
    throw err;
  }
}

queue.register('email.send', deliver, { maxAttempts: 6 });

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Minimal branded layout for platform emails. All interpolated values are escaped. */
function layout({ heading, intro, actionUrl, actionLabel, footer }) {
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;background:#f5f6fa;padding:24px">
<table role="presentation" style="max-width:560px;margin:auto;background:#fff;border-radius:12px;padding:32px">
<tr><td><h2 style="margin:0 0 16px;color:#1b1f3b">${escapeHtml(heading)}</h2>
<p style="color:#454a64;line-height:1.5">${escapeHtml(intro)}</p>
${actionUrl ? `<p><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${escapeHtml(actionLabel)}</a></p>` : ''}
<p style="color:#8a8fa8;font-size:12px">${escapeHtml(footer || 'If you did not expect this email you can ignore it.')}</p></td></tr></table></body></html>`;
  const text = `${heading}\n\n${intro}\n\n${actionUrl ? `${actionLabel}: ${actionUrl}\n\n` : ''}${footer || 'If you did not expect this email you can ignore it.'}`;
  return { html, text };
}

module.exports = { queueEmail, deliver, layout, escapeHtml, captured };
