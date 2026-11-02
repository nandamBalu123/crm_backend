'use strict';

const { DataTypes } = require('sequelize');
const { uuidv7 } = require('../utils/ids');
const tenantScope = require('../database/tenantScope');

const T = DataTypes;
const id = () => ({ type: T.CHAR(36), primaryKey: true, defaultValue: () => uuidv7() });
const ref = (allowNull = true) => ({ type: T.CHAR(36), allowNull });
const str = (len = 255, allowNull = true, extra = {}) => ({ type: T.STRING(len), allowNull, ...extra });
const text = () => ({ type: T.TEXT });
const int = (extra = {}) => ({ type: T.INTEGER, ...extra });
const dec = (p = 18, s = 2, extra = {}) => ({ type: T.DECIMAL(p, s), ...extra });
const bool = (defaultValue = false) => ({ type: T.BOOLEAN, allowNull: false, defaultValue });
const date = () => ({ type: T.DATE(3) });
const dateOnly = () => ({ type: T.DATEONLY });
const json = (defaultValue) => ({ type: T.JSON, ...(defaultValue !== undefined ? { defaultValue } : {}) });
const enm = (values, defaultValue, allowNull = defaultValue === undefined) => ({ type: T.ENUM(...values), allowNull, defaultValue });

/**
 * Model factory. `tenantScoped: true` installs the automatic tenant isolation
 * hooks; `hidden` lists attributes removed from toJSON (never serialized).
 */
function defineModel(sequelize, name, table, attributes, options = {}) {
  const { tenantScoped = false, soft = false, version = false, hidden = [], noUpdatedAt = false, noTimestamps = false, ...rest } = options;
  const attrs = { id: id(), ...(tenantScoped ? { tenant_id: ref(false) } : {}), ...attributes };
  if (version) attrs.version = { type: T.INTEGER, allowNull: false, defaultValue: 0 };
  const model = sequelize.define(name, attrs, {
    tableName: table,
    underscored: true,
    timestamps: !noTimestamps,
    createdAt: noTimestamps ? false : 'created_at',
    updatedAt: noTimestamps || noUpdatedAt ? false : 'updated_at',
    deletedAt: soft ? 'deleted_at' : false,
    paranoid: soft,
    version: version ? 'version' : false,
    tenantScoped,
    ...rest,
  });
  model.options.hiddenAttributes = hidden;
  if (hidden.length) {
    model.prototype.toJSON = function toJSON() {
      const values = { ...this.get({ plain: true }) };
      for (const h of hidden) delete values[h];
      return values;
    };
  }
  if (tenantScoped) tenantScope.install(model);
  return model;
}

module.exports = { defineModel, T, id, ref, str, text, int, dec, bool, date, dateOnly, json, enm };
