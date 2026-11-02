'use strict';

const { createRouter } = require('../../utils/router');
const { z, idParams } = require('../../utils/schemas');
const { Workflow, WorkflowRun } = require('../../models');
const { workflowBody } = require('./workflows.schema');
const engine = require('./engine');
const { OPERATORS } = require('./conditions');
const { assertLimit, requireModule } = require('../billing/entitlements.service');
const audit = require('../audit/audit.service');
const { getContext } = require('../../context/requestContext');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

const r = createRouter({ prefix: '/api/v1/workflows', tag: 'Workflow automation' });
r.router.use(requireModule('workflows'));
const present = (w) => ({ ...w.toJSON(), tenant_id: undefined });

r.get('/meta', { summary: 'Supported triggers, operators and actions', permission: 'workflows:read' }, (_req, res) => ok(res, {
  triggers: ['record.created', 'record.updated', 'field.changed', 'stage.changed', 'scheduled'],
  operators: OPERATORS,
  actions: ['create_task', 'update_field', 'assign_owner', 'notify', 'send_email', 'slack_message', 'webhook'],
}));
r.get('/', { summary: 'List workflows', permission: 'workflows:read' }, async (_req, res) => ok(res, (await Workflow.findAll({ order: [['created_at', 'DESC']] })).map(present)));
r.get('/runs', { summary: 'Recent workflow runs across all workflows', permission: 'workflows:read', query: z.object({ status: z.enum(['running', 'succeeded', 'failed', 'skipped']).optional() }) }, async (req, res) =>
  ok(res, await WorkflowRun.findAll({ where: req.valid.query.status ? { status: req.valid.query.status } : {}, order: [['created_at', 'DESC']], limit: 200 })));
r.post('/runs/:id/retry', { summary: 'Retry a failed run', permission: 'workflows:update', params: idParams }, async (req, res) => {
  const run = await engine.retryRun(req.valid.params.id);
  if (!run) throw E.notFound('Run');
  return ok(res, run);
});
r.get('/:id', { summary: 'Get a workflow', permission: 'workflows:read', params: idParams }, async (req, res) => {
  const w = await Workflow.findByPk(req.valid.params.id);
  if (!w) throw E.notFound('Workflow');
  return ok(res, present(w));
});
r.get('/:id/runs', { summary: 'Execution history', permission: 'workflows:read', params: idParams }, async (req, res) =>
  ok(res, await WorkflowRun.findAll({ where: { workflow_id: req.valid.params.id }, order: [['created_at', 'DESC']], limit: 200 })));
r.post('/', { summary: 'Create a workflow', permission: 'workflows:create', body: workflowBody }, async (req, res) => {
  await assertLimit('workflows', await Workflow.count());
  const w = await Workflow.create({ ...req.valid.body, created_by_user_id: getContext().userId, next_run_at: req.valid.body.trigger.type === 'scheduled' ? new Date() : null });
  await audit.record({ action: 'workflow.created', entityType: 'workflow', entityId: w.id, summary: `Workflow ${w.name} created`, metadata: { trigger: w.trigger, actions: w.actions.map((a) => a.type) } });
  return created(res, present(w));
});
r.put('/:id', { summary: 'Replace a workflow definition', permission: 'workflows:update', params: idParams, body: workflowBody.extend({ version: z.number().int().optional() }) }, async (req, res) => {
  const w = await Workflow.findByPk(req.valid.params.id);
  if (!w) throw E.notFound('Workflow');
  const { version, ...body } = req.valid.body;
  if (version !== undefined && version !== w.version) throw E.conflict('Workflow was changed by someone else', 'VERSION_CONFLICT');
  await w.update({ ...body, next_run_at: body.trigger.type === 'scheduled' ? w.next_run_at || new Date() : null });
  await audit.record({ action: 'workflow.updated', entityType: 'workflow', entityId: w.id, summary: `Workflow ${w.name} updated` });
  return ok(res, present(w));
});
r.patch('/:id', { summary: 'Enable or disable a workflow', permission: 'workflows:update', params: idParams, body: z.strictObject({ is_active: z.boolean() }) }, async (req, res) => {
  const w = await Workflow.findByPk(req.valid.params.id);
  if (!w) throw E.notFound('Workflow');
  await w.update(req.valid.body);
  await audit.record({ action: req.valid.body.is_active ? 'workflow.enabled' : 'workflow.disabled', entityType: 'workflow', entityId: w.id, summary: `Workflow ${w.name} ${req.valid.body.is_active ? 'enabled' : 'disabled'}` });
  return ok(res, present(w));
});
r.delete('/:id', { summary: 'Delete a workflow and its history', permission: 'workflows:delete', params: idParams }, async (req, res) => {
  const w = await Workflow.findByPk(req.valid.params.id);
  if (!w) throw E.notFound('Workflow');
  await WorkflowRun.destroy({ where: { workflow_id: w.id } });
  await w.destroy();
  await audit.record({ action: 'workflow.deleted', entityType: 'workflow', entityId: w.id, summary: `Workflow ${w.name} deleted` });
  return noContent(res);
});

module.exports = r;
