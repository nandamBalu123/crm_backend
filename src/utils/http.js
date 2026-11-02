'use strict';

const ok = (res, data, meta) => res.status(200).json(meta ? { data, meta } : { data });
const created = (res, data) => res.status(201).json({ data });
const accepted = (res, data) => res.status(202).json({ data });
const noContent = (res) => res.status(204).end();

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

module.exports = { ok, created, accepted, noContent, clientIp };
