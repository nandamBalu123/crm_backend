'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { sequelize } = require('../../models');

const router = express.Router();
const MIGRATIONS = fs.readdirSync(path.resolve(__dirname, '../../database/migrations')).filter((f) => f.endsWith('.js'));

router.get('/health/live', (_req, res) => res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) }));

router.get('/health/ready', async (_req, res) => {
  try {
    await sequelize.query('SELECT 1');
    const [rows] = await sequelize.query('SELECT name FROM sequelize_meta');
    const applied = new Set(rows.map((r) => r.name));
    const pending = MIGRATIONS.filter((m) => !applied.has(m));
    if (pending.length) return res.status(503).json({ status: 'migrations_pending', pending: pending.length });
    return res.json({ status: 'ready' });
  } catch {
    return res.status(503).json({ status: 'database_unavailable' });
  }
});

module.exports = router;
