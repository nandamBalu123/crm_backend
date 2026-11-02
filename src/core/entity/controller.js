'use strict';

const service = require('./service');
const timeline = require('../../modules/timeline/timeline.service');
const { ok, created, noContent } = require('../../utils/http');

/** Standard CRUD handlers for a CRM entity definition. Controllers only translate HTTP ↔ service. */
function entityController(def) {
  return {
    list: async (req, res) => {
      const { data, meta } = await service.list(def, req.valid.query || req.query, req.scope);
      return ok(res, data, meta);
    },
    get: async (req, res) => ok(res, await service.get(def, req.valid.params.id, req.scope)),
    create: async (req, res) => created(res, await (def.createOverride ? def.createOverride(req.valid.body) : service.create(def, req.valid.body))),
    update: async (req, res) => {
      const expectedVersion = req.get('if-match') ? Number(req.get('if-match').replace(/"/g, '')) : undefined;
      if (def.updateOverride) return ok(res, await def.updateOverride(req.valid.params.id, req.valid.body, req.scope));
      return ok(res, await service.update(def, req.valid.params.id, req.valid.body, req.scope, { expectedVersion }));
    },
    remove: async (req, res) => {
      await service.remove(def, req.valid.params.id, req.scope);
      return noContent(res);
    },
    bulk: async (req, res) => ok(res, await service.bulk(def, req.valid.body)),
    exportCsv: async (req, res) => service.exportCsv(def, req.valid.query || req.query, req.scope, res),
    timeline: async (req, res) => {
      await service.findScoped(def, req.valid.params.id, req.scope);
      return ok(res, await timeline.feed({ entityType: def.type, entityId: req.valid.params.id, relationField: def.timelineRelation, limit: Number(req.query.limit) || 30, before: req.query.before }));
    },
    assignments: async (req, res) => ok(res, await service.assignments(def, req.valid.params.id, req.scope)),
  };
}

module.exports = { entityController };
