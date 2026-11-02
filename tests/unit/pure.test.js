'use strict';

const money = require('../../src/utils/money');
const { evaluate, evaluateCondition, getField } = require('../../src/modules/workflows/conditions');
const totp = require('../../src/modules/auth/totp');
const { encrypt, decrypt, signPayload, verifyPayload, safeEqual } = require('../../src/utils/crypto');
const { csvSafe } = require('../../src/core/entity/service');
const { uuidv7, isUuid } = require('../../src/utils/ids');
const { detect, safeFilename } = require('../../src/modules/attachments/fileTypes');
const { render, sanitizeHtml } = require('../../src/modules/communications/templating');
const { scoreLead } = require('../../src/modules/leads/scoring');
const { sequelize } = require('../../src/models');

afterAll(() => sequelize.close());

describe('money (BigInt fixed point)', () => {
  test('exact decimal arithmetic without float errors', () => {
    const a = money.toFixedBig('0.1');
    const b = money.toFixedBig('0.2');
    expect(money.toString(a + b, 2)).toBe('0.30');
    expect(money.toString(money.mul(money.toFixedBig('19.99'), money.toFixedBig('3')), 2)).toBe('59.97');
    expect(money.toString(money.pct(money.toFixedBig('227.89'), money.toFixedBig('8.25')), 2)).toBe('18.80');
  });
  test('rounds half away from zero', () => {
    expect(money.toString(money.toFixedBig('2.345'), 2)).toBe('2.35');
    expect(money.toString(money.toFixedBig('-2.345'), 2)).toBe('-2.35');
    expect(money.toString(money.toFixedBig('2.344'), 2)).toBe('2.34');
  });
  test('rejects non-decimals and accepts BigInt passthrough', () => {
    expect(() => money.toFixedBig('1e5')).toThrow();
    expect(() => money.toFixedBig('abc')).toThrow();
    expect(money.toFixedBig(5000000n)).toBe(5000000n);
  });
});

describe('workflow condition evaluator', () => {
  const rec = { status: 'qualified', amount: '1500', tags: ['vip'], custom_fields: { tier: 'Gold' }, title: 'VP Sales' };
  test('operators', () => {
    expect(evaluate({ all: [{ field: 'status', op: 'eq', value: 'QUALIFIED' }, { field: 'amount', op: 'gte', value: 1000 }] }, rec)).toBe(true);
    expect(evaluate({ any: [{ field: 'status', op: 'eq', value: 'new' }, { field: 'custom_fields.tier', op: 'in', value: ['gold'] }] }, rec)).toBe(true);
    expect(evaluateCondition({ field: 'tags', op: 'contains', value: 'vip' }, rec)).toBe(true);
    expect(evaluateCondition({ field: 'title', op: 'contains_any', value: ['director', 'vp'] }, rec)).toBe(true);
    expect(evaluateCondition({ field: 'status', op: 'changed_to', value: 'qualified' }, rec, { changes: { status: {} } })).toBe(true);
    expect(evaluate(null, rec)).toBe(true);
  });
  test('cannot reach prototypes or run code', () => {
    expect(getField(rec, '__proto__.polluted')).toBeUndefined();
    expect(getField(rec, 'constructor.name')).toBeUndefined();
    expect(() => evaluateCondition({ field: 'status', op: 'eval', value: 'process.exit()' }, rec)).toThrow(/Unknown operator/);
    let deep = { field: 'status', op: 'eq', value: 'x' };
    for (let i = 0; i < 10; i += 1) deep = { all: [deep] };
    expect(() => evaluate(deep, rec)).toThrow(/too deep/);
  });
  test('lead scoring', () => {
    expect(scoreLead({ email: 'a@b.c', rating: 'hot' }, [{ field: 'email', op: 'is_not_empty', points: 10 }, { field: 'rating', op: 'eq', value: 'hot', points: 25 }])).toBe(35);
    expect(scoreLead({}, [{ field: 'x', op: 'bogus', points: 5 }])).toBe(0);
  });
});

describe('TOTP (RFC 6238)', () => {
  test('matches the RFC test vector (SHA-1, 59s → 287082)', () => {
    const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
    expect(totp.hotp(secret, Math.floor(59 / 30))).toBe('287082');
  });
  test('verifies within ±1 step and rejects replays', () => {
    const s = totp.generateSecret();
    const now = Date.now();
    const step = totp.verify(s, totp.generate(s, now), { now });
    expect(step).not.toBeNull();
    expect(totp.verify(s, totp.generate(s, now), { now, lastUsedStep: step })).toBeNull();
    expect(totp.verify(s, '12345', { now })).toBeNull();
  });
});

describe('crypto helpers', () => {
  test('AES-GCM round trip and tamper detection', () => {
    const c = encrypt('secret value');
    expect(c).not.toContain('secret');
    expect(decrypt(c)).toBe('secret value');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });
  test('signed payloads expire and reject tampering', () => {
    const t = signPayload({ a: 1 }, 60);
    expect(verifyPayload(t).a).toBe(1);
    expect(verifyPayload(`${t}x`)).toBeNull();
    expect(verifyPayload(signPayload({ a: 1 }, -1))).toBeNull();
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
  });
});

describe('misc safety utilities', () => {
  test('CSV formula injection is neutralised', () => {
    expect(csvSafe('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvSafe('+1')).toBe("'+1");
    expect(csvSafe('@cmd')).toBe("'@cmd");
    expect(csvSafe('normal')).toBe('normal');
    expect(csvSafe(['a', 'b'])).toBe('a; b');
  });
  test('UUIDv7 ids are valid and time ordered', () => {
    const ids = Array.from({ length: 50 }, uuidv7);
    expect(ids.every(isUuid)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });
  test('upload content sniffing', () => {
    expect(detect('a.pdf', Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detect('a.pdf', Buffer.from('<html>'))).toBeNull();
    expect(detect('a.svg', Buffer.from('<svg/>'))).toBeNull();
    expect(detect('a.txt', Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(detect('a.csv', Buffer.from('a,b\n1,2'))).toBe('text/csv');
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('a"\u0000b.pdf')).toBe('a__b.pdf');
  });
  test('templating escapes values and strips active content', () => {
    expect(render('Hi {{first_name}}', { first_name: '<b>x</b>' }, { html: true })).toBe('Hi &lt;b&gt;x&lt;/b&gt;');
    // Own properties only: prototype names resolve to nothing; invalid names stay literal text.
    expect(render('{{constructor}}{{toString}}{{__proto__}}', {})).toBe('{{__proto__}}');
    const clean = sanitizeHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">l</a><iframe src=x></iframe>');
    expect(clean).not.toMatch(/onclick|<script|javascript:|<iframe/i);
  });
});
