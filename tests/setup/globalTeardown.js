'use strict';

module.exports = async function globalTeardown() {
  if (globalThis.__MYSQL__) await globalThis.__MYSQL__.stop();
};
