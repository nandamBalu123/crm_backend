'use strict';

const { z } = require('zod');
const { OPERATORS } = require('./conditions');

const ENTITY_TYPES = ['lead', 'contact', 'account', 'opportunity', 'activity', 'ticket', 'quote'];
const fieldPath = z.string().regex(/^[a-z_][a-z0-9_]{0,62}(\.[a-z0-9_]{1,63})?$/, 'Invalid field');

const condition = z.strictObject({ field: fieldPath, op: z.enum(OPERATORS), value: z.any().optional() });
const group = z.lazy(() => z.union([
  z.strictObject({ all: z.array(z.union([condition, group])).max(20) }),
  z.strictObject({ any: z.array(z.union([condition, group])).max(20) }),
]));

const trigger = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('record.created') }),
  z.strictObject({ type: z.literal('record.updated') }),
  z.strictObject({ type: z.literal('field.changed'), field: fieldPath, to_value: z.any().optional() }),
  z.strictObject({ type: z.literal('stage.changed'), to_stage_id: z.string().uuid().optional() }),
  z.strictObject({ type: z.literal('scheduled'), interval_minutes: z.coerce.number().int().min(15).max(10080), once_per_record: z.boolean().default(true) }),
]);

const recipient = z.union([z.enum(['record_owner', 'trigger_user']), z.string().uuid()]);
const action = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('create_task'), params: z.strictObject({ subject: z.string().min(1).max(255), description: z.string().max(5000).optional(), due_in_days: z.coerce.number().int().min(0).max(365).default(1), priority: z.enum(['low', 'normal', 'high']).default('normal'), assign_to: recipient.default('record_owner') }) }),
  z.strictObject({ type: z.literal('update_field'), params: z.strictObject({ field: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/), value: z.any() }) }),
  z.strictObject({ type: z.literal('assign_owner'), params: z.strictObject({ strategy: z.enum(['user', 'round_robin']), user_ids: z.array(z.string().uuid()).min(1).max(100) }) }),
  z.strictObject({ type: z.literal('notify'), params: z.strictObject({ recipients: z.array(recipient).min(1).max(20), title: z.string().min(1).max(200), message: z.string().max(1000).optional() }) }),
  z.strictObject({ type: z.literal('send_email'), params: z.strictObject({ template_id: z.string().uuid() }) }),
  z.strictObject({ type: z.literal('slack_message'), params: z.strictObject({ text: z.string().min(1).max(3000), channel: z.string().max(80).optional() }) }),
  z.strictObject({ type: z.literal('webhook'), params: z.strictObject({ url: z.string().url().max(1000) }) }),
]);

const workflowBody = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullish(),
  entity_type: z.enum(ENTITY_TYPES),
  trigger,
  conditions: group.nullish(),
  actions: z.array(action).min(1).max(10),
  is_active: z.boolean().optional(),
});

module.exports = { workflowBody, ENTITY_TYPES };
