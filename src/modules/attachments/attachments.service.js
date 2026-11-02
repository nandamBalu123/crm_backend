'use strict';

const crypto = require('node:crypto');
const { fn, col } = require('sequelize');
const { Attachment, User } = require('../../models');
const registry = require('../../core/entity/registry');
const service = require('../../core/entity/service');
const { scopeFor } = require('../../middleware/authorize');
const { driver } = require('../../storage');
const { detect, safeFilename } = require('./fileTypes');
const { assertLimit } = require('../billing/entitlements.service');
const { signPayload } = require('../../utils/crypto');
const { uuidv7 } = require('../../utils/ids');
const timeline = require('../timeline/timeline.service');
const audit = require('../audit/audit.service');
const { getContext } = require('../../context/requestContext');
const env = require('../../config/env');
const E = require('../../errors/AppError');

const ATTACHABLE = ['lead', 'contact', 'account', 'opportunity', 'ticket', 'quote', 'activity', 'campaign'];

/** The caller must be able to read the parent record (permission + record scope). */
async function assertParentAccess(entityType, entityId) {
  if (!ATTACHABLE.includes(entityType)) throw E.validation([{ path: 'entity_type', message: 'Files cannot be attached to this type' }]);
  const def = registry.get(entityType);
  const scope = scopeFor(getContext(), `${def.module}:read`);
  if (!scope) throw E.forbidden(`Missing permission: ${def.module}:read`, 'PERMISSION_DENIED');
  await service.findScoped(def, entityId, scope);
}

async function upload({ entityType, entityId, file }) {
  const ctx = getContext();
  await assertParentAccess(entityType, entityId);
  if (!file) throw E.validation([{ path: 'file', message: 'A file is required' }]);
  const mime = detect(file.originalname, file.buffer);
  if (!mime) throw E.validation([{ path: 'file', message: 'File type not allowed or content does not match its extension' }]);
  const [{ total }] = await Attachment.findAll({ attributes: [[fn('COALESCE', fn('SUM', col('size_bytes')), 0), 'total']], raw: true });
  await assertLimit('storage_mb', Math.floor((Number(total) + file.size) / 1048576));
  const id = uuidv7();
  const key = `tenants/${ctx.tenantId}/attachments/${id}`;
  const store = driver();
  await store.put(key, file.buffer);
  try {
    const att = await Attachment.create({
      id, entity_type: entityType, entity_id: entityId, filename: safeFilename(file.originalname), mime_type: mime, size_bytes: file.size,
      sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), storage_driver: store.name, storage_key: key, uploaded_by_user_id: ctx.userId,
    });
    await timeline.add(entityType, entityId, 'file_attached', `File attached: ${att.filename}`, { attachment_id: id });
    await audit.record({ action: 'file.uploaded', entityType, entityId, summary: `Uploaded ${att.filename}`, metadata: { attachment_id: id, size: file.size, mime } });
    return att;
  } catch (err) {
    await store.remove(key).catch(() => {});
    throw err;
  }
}

async function list(entityType, entityId) {
  await assertParentAccess(entityType, entityId);
  return Attachment.findAll({ where: { entity_type: entityType, entity_id: entityId }, order: [['created_at', 'DESC']], include: [{ model: User, as: 'uploader', attributes: ['id', 'first_name', 'last_name'] }] });
}

async function getAuthorized(id) {
  const att = await Attachment.findByPk(id);
  if (!att) throw E.notFound('File');
  await assertParentAccess(att.entity_type, att.entity_id);
  return att;
}

async function stream(att, res, { audited = true } = {}) {
  const body = await driver(att.storage_driver).get(att.storage_key);
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Length', String(att.size_bytes));
  res.setHeader('Content-Disposition', `attachment; filename="${att.filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (audited) await audit.record({ action: 'file.downloaded', entityType: att.entity_type, entityId: att.entity_id, metadata: { attachment_id: att.id } });
  body.on('error', () => res.destroy());
  body.pipe(res);
}

/** Short-lived (5 min) download link bound to tenant, file and requesting user. */
function signedLink(att) {
  const ctx = getContext();
  return `${env.API_URL}/api/v1/public/files/${signPayload({ t: ctx.tenantId, a: att.id, u: ctx.userId }, 300)}`;
}

async function remove(id) {
  const att = await getAuthorized(id);
  await att.destroy();
  await timeline.add(att.entity_type, att.entity_id, 'file_deleted', `File deleted: ${att.filename}`);
  await audit.record({ action: 'file.deleted', entityType: att.entity_type, entityId: att.entity_id, metadata: { attachment_id: att.id } });
}

module.exports = { upload, list, getAuthorized, stream, signedLink, remove, ATTACHABLE };
