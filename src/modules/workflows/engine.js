'use strict';

const { Op } = require('sequelize');
const { sequelize, Workflow, WorkflowRun } = require('../../models');
const registry = require('../../core/entity/registry');
const service = require('../../core/entity/service');
const { evaluate } = require('./conditions');
const { registerDispatchTarget } = require('../../jobs/dispatch');
const queue = require('../../jobs/queue');
const notifications = require('../notifications/notifications.service');
const integrations = require('../integrations/integrations.service');
const { safeFetch } = require('../../utils/safeFetch');
const { hmac } = require('../../utils/crypto');
const env = require('../../config/env');
const { getContext, runAsSystem, runInTenant } = require('../../context/requestContext');
const { logger } = require('../../logging/logger');

const MAX_DEPTH = 3;
const rr = new Map(); // round-robin cursor per workflow (per process; resets are harmless)

function matchesTrigger(wf, event) {
  const [entity, verb] = event.type.split('.');
  if (entity !== wf.entity_type) return false;
  const t = wf.trigger || {};
  switch (t.type) {
    case 'record.created': return verb === 'created';
    case 'record.updated': return verb === 'updated';
    case 'field.changed': {
      if (verb !== 'updated' || !event.changes) return false;
      const key = t.field.startsWith('custom_fields.') ? `cf.${t.field.slice(14)}` : t.field;
      const ch = event.changes[key];
      return !!ch && (t.to_value === undefined || String(ch.to) === String(t.to_value));
    }
    case 'stage.changed': return verb === 'stage_changed' && (!t.to_stage_id || event.data?.stage_id === t.to_stage_id);
    default: return false;
  }
}

function resolveUsers(list, record, triggerUser) {
  return [...new Set(list.map((r) => (r === 'record_owner' ? record.owner_id : r === 'trigger_user' ? triggerUser : r)).filter(Boolean))];
}

/** Executes the whitelisted actions of one workflow against one record. */
async function runActions(wf, record, { triggerUser }) {
  const def = registry.get(wf.entity_type);
  const ctx = getContext();
  const steps = [];
  for (const [i, action] of (wf.actions || []).entries()) {
    const p = action.params || {};
    try {
      let result;
      switch (action.type) {
        case 'create_task': {
          const owner = resolveUsers([p.assign_to || 'record_owner'], record, triggerUser)[0] || null;
          const relation = { lead: 'lead_id', contact: 'contact_id', account: 'account_id', opportunity: 'opportunity_id', ticket: 'ticket_id' }[wf.entity_type];
          const task = await sequelize.transaction((t) => service.createRecord(registry.activity, {
            type: 'task', subject: p.subject, description: p.description, priority: p.priority || 'normal', owner_id: owner,
            due_at: new Date(Date.now() + (p.due_in_days ?? 1) * 86400_000), ...(relation ? { [relation]: record.id } : {}),
          }, { transaction: t, skipOwnerCheck: true }));
          result = { activity_id: task.id };
          break;
        }
        case 'update_field': {
          if (p.field === 'owner_id' || p.field === 'tenant_id' || !def.updateSchema.shape[p.field]) throw new Error(`Field ${p.field} cannot be updated by workflows`);
          const parsed = def.updateSchema.safeParse({ [p.field]: p.value });
          if (!parsed.success) throw new Error(`Invalid value for ${p.field}: ${parsed.error.issues[0].message}`);
          await sequelize.transaction((t) => service.updateRecord(def, record.id, parsed.data, 'all', { transaction: t }));
          Object.assign(record, parsed.data); // later actions see the change
          result = { field: p.field };
          break;
        }
        case 'assign_owner': {
          let owner = p.user_ids[0];
          if (p.strategy === 'round_robin') {
            const n = rr.get(wf.id) || 0;
            owner = p.user_ids[n % p.user_ids.length];
            rr.set(wf.id, n + 1);
          }
          await sequelize.transaction((t) => service.updateRecord(def, record.id, { owner_id: owner }, 'all', { transaction: t, reason: `workflow:${wf.name}` }));
          record.owner_id = owner;
          result = { owner_id: owner };
          break;
        }
        case 'notify': {
          const users = resolveUsers(p.recipients, record, triggerUser);
          for (const u of users) await notifications.notify(u, { type: 'workflow.notification', title: p.title, body: p.message || def.title(record), link: `/${def.route}/${record.id}`, entity_type: wf.entity_type, entity_id: record.id });
          result = { notified: users.length };
          break;
        }
        case 'send_email': {
          const comms = require('../communications/communications.service');
          const target = wf.entity_type === 'lead' ? { lead_id: record.id } : wf.entity_type === 'contact' ? { contact_id: record.id } : record.contact_id ? { contact_id: record.contact_id } : null;
          if (!target) throw new Error('This record has no email recipient');
          const comm = await comms.send({ channel: 'email', template_id: p.template_id, ...target });
          result = { communication_id: comm.id, status: comm.status };
          break;
        }
        case 'slack_message': {
          const slack = await integrations.connectionFor('chat.post');
          if (!slack) throw new Error('Slack is not connected');
          const text = p.text.replace(/\{\{\s*record\.([a-z_]+)\s*\}\}/g, (_m, f) => String(record[f] ?? ''));
          result = await slack.provider.postMessage({ config: slack.config, secrets: slack.secrets }, { channel: p.channel, text });
          break;
        }
        case 'webhook': {
          const body = JSON.stringify({ workflow: wf.name, entity_type: wf.entity_type, record });
          const t = Math.floor(Date.now() / 1000);
          const res = await safeFetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CRM-Signature': `t=${t},v1=${hmac(env.SIGNING_SECRET + ctx.tenantId, `${t}.${body}`)}` }, body });
          if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
          result = { status: res.status };
          break;
        }
        default:
          throw new Error(`Unsupported action ${action.type}`);
      }
      steps.push({ index: i, type: action.type, status: 'succeeded', result });
    } catch (err) {
      steps.push({ index: i, type: action.type, status: 'failed', error: String(err.message).slice(0, 500) });
      return { steps, error: `Action ${i + 1} (${action.type}) failed: ${err.message}` };
    }
  }
  return { steps };
}

async function execute(wf, record, { triggerEvent, triggerUser, attempt = 1 }) {
  const ctx = getContext();
  const run = await WorkflowRun.create({ workflow_id: wf.id, entity_type: wf.entity_type, entity_id: record.id, trigger_event: triggerEvent, status: 'running', attempt, started_at: new Date() });
  const prevDepth = ctx.workflowDepth || 0;
  Object.assign(ctx, { workflowDepth: prevDepth + 1, actorLabel: `workflow:${wf.name}` });
  let outcome;
  try {
    outcome = await runActions(wf, record, { triggerUser });
  } finally {
    ctx.workflowDepth = prevDepth;
  }
  const failed = !!outcome.error;
  await run.update({ status: failed ? 'failed' : 'succeeded', steps: outcome.steps, error: outcome.error || null, finished_at: new Date() });
  await Workflow.update({ last_run_at: new Date(), run_count: sequelize.literal('run_count + 1'), ...(failed ? { failure_count: sequelize.literal('failure_count + 1') } : {}) }, { where: { id: wf.id }, silent: true });
  if (failed && wf.created_by_user_id) {
    await notifications.notify(wf.created_by_user_id, { type: 'workflow.notification', title: `Workflow failed: ${wf.name}`, body: outcome.error, link: `/settings/workflows/${wf.id}` });
  }
  return run;
}

/** Event dispatch target. Idempotent: one run per (workflow, event). Loop-protected by depth. */
async function handleEvent(event) {
  if ((event.workflow_depth || 0) >= MAX_DEPTH) {
    logger.warn({ type: event.type }, 'workflow depth limit reached; not triggering');
    return;
  }
  const entityType = event.type.split('.')[0];
  const workflows = await Workflow.findAll({ where: { entity_type: entityType, is_active: true } });
  const candidates = workflows.filter((wf) => matchesTrigger(wf, event));
  if (!candidates.length) return;
  const record = { ...(event.data || {}) };
  for (const wf of candidates) {
    if (await WorkflowRun.findOne({ where: { workflow_id: wf.id, trigger_event: event.id }, attributes: ['id'] })) continue;
    let pass;
    try {
      pass = evaluate(wf.conditions, record, { changes: event.changes });
    } catch (err) {
      await WorkflowRun.create({ workflow_id: wf.id, entity_type: entityType, entity_id: event.entity_id, trigger_event: event.id, status: 'failed', error: `Invalid conditions: ${err.message}`, started_at: new Date(), finished_at: new Date() });
      continue;
    }
    if (!pass) continue;
    const ctx = getContext();
    ctx.workflowDepth = event.workflow_depth || 0;
    await execute(wf, record, { triggerEvent: event.id, triggerUser: event.actor_user_id });
  }
}

async function retryRun(runId) {
  const run = await WorkflowRun.findByPk(runId);
  if (!run) return null;
  const wf = await Workflow.findByPk(run.workflow_id);
  const def = registry.get(run.entity_type);
  const record = await def.model.findByPk(run.entity_id);
  if (!wf || !record) throw new Error('Workflow or record no longer exists');
  const values = (await require('../customFields/customFields.service').loadValues(run.entity_type, [record.id])).get(record.id);
  return execute(wf, { ...record.get({ plain: true }), custom_fields: values }, { triggerEvent: `retry:${run.id}`.slice(0, 60), triggerUser: getContext().userId, attempt: run.attempt + 1 });
}

/** Scheduled workflows: evaluate conditions over recently updated records (bounded batch). */
async function runScheduled() {
  const now = new Date();
  const due = await runAsSystem('workflows:scheduled-scan', () => Workflow.findAll({ where: { is_active: true, next_run_at: { [Op.or]: [null, { [Op.lte]: now }] } }, attributes: ['id', 'tenant_id', 'trigger'] }));
  let runs = 0;
  for (const w of due.filter((x) => x.trigger?.type === 'scheduled')) {
    await runInTenant(w.tenant_id, async () => {
      const wf = await Workflow.findByPk(w.id);
      await wf.update({ next_run_at: new Date(now.getTime() + wf.trigger.interval_minutes * 60_000) }, { silent: true });
      const def = registry.get(wf.entity_type);
      const records = await def.model.findAll({ order: [['updated_at', 'DESC']], limit: 1000 });
      const cfValues = await require('../customFields/customFields.service').loadValues(wf.entity_type, records.map((r) => r.id));
      for (const rec of records) {
        const plain = { ...rec.get({ plain: true }), custom_fields: cfValues.get(rec.id) || {} };
        if (!evaluate(wf.conditions, plain)) continue;
        if (wf.trigger.once_per_record !== false && (await WorkflowRun.findOne({ where: { workflow_id: wf.id, entity_id: rec.id, status: 'succeeded' }, attributes: ['id'] }))) continue;
        await execute(wf, plain, { triggerEvent: `scheduled:${now.toISOString().slice(0, 16)}` });
        runs += 1;
      }
    }, { actorLabel: 'workflow-scheduler' });
  }
  return { runs };
}

registerDispatchTarget('workflows', handleEvent);
queue.register('workflows.scheduled', runScheduled, { maxAttempts: 2 });

module.exports = { handleEvent, matchesTrigger, retryRun, runScheduled, execute };
