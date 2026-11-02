'use strict';

const { escapeHtml } = require('../../integrations/mail/mailer');

/**
 * Logic-less {{variable}} substitution. Only [a-z0-9_.] names are recognised;
 * HTML output escapes every value. No expressions, helpers or code execution.
 */
const VAR = /\{\{\s*([a-z][a-z0-9_.]{0,60})\s*\}\}/gi;

function lookup(vars, path) {
  return path.split('.').reduce((o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), vars);
}

function render(template, vars, { html = false } = {}) {
  return String(template || '').replace(VAR, (_m, name) => {
    const v = lookup(vars, name);
    if (v === undefined || v === null) return '';
    return html ? escapeHtml(v) : String(v);
  });
}

/** Removes active content from tenant-authored HTML templates (scripts, handlers, javascript: URLs). */
function sanitizeHtml(input) {
  return String(input || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)[\s\S]*?(<\s*\/\s*\1\s*>|\/?>)/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*(javascript|vbscript|data):[^"'\s>]*\2/gi, '$1="#"');
}

const htmlToText = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

module.exports = { render, sanitizeHtml, htmlToText };
