'use strict';

const { evaluateCondition } = require('../workflows/conditions');

/** Rule-based lead scoring configured per tenant (settings.preferences.lead_scoring.rules). */
function scoreLead(lead, rules = []) {
  let score = 0;
  for (const rule of rules.slice(0, 50)) {
    try {
      if (evaluateCondition({ field: rule.field, op: rule.op, value: rule.value }, lead)) score += Number(rule.points) || 0;
    } catch {
      /* invalid rule configuration is ignored for scoring */
    }
  }
  return Math.max(0, Math.min(1000, score));
}

module.exports = { scoreLead };
