'use strict';

// Writes the generated OpenAPI document to docs/openapi.json.
const fs = require('node:fs');
const path = require('node:path');
require('../src/jobs/handlers');
const { createApp } = require('../src/app');
const { buildOpenApi } = require('../src/openapi/generator');

createApp();
const out = path.resolve(__dirname, '../../docs/openapi.json');
fs.writeFileSync(out, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
console.log(`Wrote ${out}`);
process.exit(0);
