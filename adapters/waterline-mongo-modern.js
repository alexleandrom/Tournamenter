'use strict';
/**
 * waterline-mongo-modern
 *
 * Waterline 0.12-compatible adapter using the modern mongodb driver (v6.x).
 * Replaces sails-mongo which stopped working on MongoDB 5+.
 *
 * Implements the Waterline 0.12 adapter interface:
 *   registerConnection, teardown, describe, define, drop,
 *   find, create, update, destroy, count
 */

const { MongoClient, ObjectId } = require('mongodb');

// connectionName → { client, db }
const _connections = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

function toObjectId(val) {
  if (val instanceof ObjectId) return val;
  if (typeof val === 'string' && /^[0-9a-f]{24}$/i.test(val)) {
    return new ObjectId(val);
  }
  return val;
}

/**
 * Normalize a raw MongoDB document to look like a Waterline record:
 *  - adds `id` as string alias for `_id`
 */
function normalizeDoc(doc) {
  if (!doc) return null;
  const out = Object.assign({}, doc);
  if (out._id !== undefined) {
    out.id  = out._id.toString();
  }
  return out;
}

/**
 * Convert Waterline `where` criteria to a MongoDB filter.
 *
 * Waterline operators we translate:
 *   { field: { contains: 'x' } }  → { field: /x/i }
 *   { field: { startsWith: 'x' }} → { field: /^x/i }
 *   { field: { endsWith: 'x' } }  → { field: /x$/i }
 *   { field: { '>': n } }         → { field: { $gt: n } }
 *   { field: { '<': n } }         → { field: { $lt: n } }
 *   { field: { '>=': n } }        → { field: { $gte: n } }
 *   { field: { '<=': n } }        → { field: { $lte: n } }
 *   { field: { '!': v } }         → { field: { $ne: v } }
 *   { or: [ ... ] }               → { $or: [...] }
 */
function buildFilter(where) {
  if (!where) return {};

  const filter = {};

  for (const [key, val] of Object.entries(where)) {
    // `id` → `_id` (ObjectId)
    if (key === 'id') {
      if (Array.isArray(val)) {
        filter._id = { $in: val.map(toObjectId) };
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        filter._id = translateOperators(val, true);
      } else {
        filter._id = toObjectId(val);
      }
      continue;
    }

    // `or` → `$or`
    if (key === 'or') {
      filter.$or = val.map(buildFilter);
      continue;
    }

    if (val !== null && typeof val === 'object' && !Array.isArray(val)
        && !(val instanceof ObjectId)) {
      filter[key] = translateOperators(val, false);
    } else {
      filter[key] = val;
    }
  }

  return filter;
}

function translateOperators(obj, isId) {
  const result = {};
  let hasOps = false;

  for (const [op, v] of Object.entries(obj)) {
    hasOps = true;
    switch (op) {
      case 'contains':    result.$regex = new RegExp(v, 'i'); break;
      case 'startsWith':  result.$regex = new RegExp('^' + v, 'i'); break;
      case 'endsWith':    result.$regex = new RegExp(v + '$', 'i'); break;
      case 'like':        result.$regex = new RegExp(v.replace(/%/g, '.*'), 'i'); break;
      case '!':
      case 'not':         result.$ne = isId ? toObjectId(v) : v; break;
      case '>':           result.$gt  = v; break;
      case '<':           result.$lt  = v; break;
      case '>=':          result.$gte = v; break;
      case '<=':          result.$lte = v; break;
      case 'in':          result.$in  = Array.isArray(v) ? v : [v]; break;
      case 'nin':
      case 'notIn':       result.$nin = Array.isArray(v) ? v : [v]; break;
      default:            result['$' + op] = v;
    }
  }

  return hasOps ? result : obj;
}

/**
 * Build MongoDB sort from Waterline sort option.
 * Waterline: { name: 1 } | { name: 'asc' } | 'name asc'
 */
function buildSort(sort) {
  if (!sort) return null;
  if (typeof sort === 'string') {
    const [field, dir] = sort.trim().split(/\s+/);
    return { [field]: dir && dir.toLowerCase() === 'desc' ? -1 : 1 };
  }
  const result = {};
  for (const [k, v] of Object.entries(sort)) {
    result[k] = (v === -1 || v === 'desc' || v === 'DESC') ? -1 : 1;
  }
  return result;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

const adapter = module.exports = {
  identity: 'waterline-mongo-modern',
  syncable: false,
  defaults: {},

  // ── Connection ─────────────────────────────────────────────────────────────

  registerConnection(connection, collections, cb) {
    const url = connection.url;
    if (!url) return cb(new Error('waterline-mongo-modern: connection.url is required'));

    MongoClient.connect(url)
      .then(client => {
        const db = client.db();
        _connections[connection.identity] = { client, db };
        console.log('[waterline-mongo-modern] Connected! db:', db.databaseName, '| collections:', Object.keys(collections).join(','));
        cb();
      })
      .catch(err => {
        console.error('[waterline-mongo-modern] Connection error:', err.message);
        cb(err);
      });
  },

  teardown(connName, cb) {
    const conn = _connections[connName];
    if (conn) {
      conn.client.close()
        .then(() => { delete _connections[connName]; cb(); })
        .catch(cb);
    } else {
      cb();
    }
  },

  // ── DDL (no-ops for MongoDB) ───────────────────────────────────────────────

  describe(connName, collName, cb)              { cb(null, {}); },
  define(connName, collName, definition, cb)    { cb(); },
  drop(connName, collName, relations, cb)        { cb(); },

  // ── DQL ───────────────────────────────────────────────────────────────────

  find(connName, collName, options, cb) {
    const { db } = _connections[connName];
    const filter = buildFilter(options.where);
    const sort   = buildSort(options.sort);
    const skip   = options.skip  || 0;
    const limit  = options.limit || 0;

    console.log('[waterline-mongo-modern] find', collName, 'where:', JSON.stringify(options.where), '→ filter:', JSON.stringify(filter));
    let cursor = db.collection(collName).find(filter);
    if (sort)  cursor = cursor.sort(sort);
    if (skip)  cursor = cursor.skip(skip);
    if (limit) cursor = cursor.limit(limit);

    cursor.toArray()
      .then(docs => {
        console.log('[waterline-mongo-modern] find result', collName, docs.length, 'docs');
        cb(null, docs.map(normalizeDoc));
      })
      .catch(err => {
        console.error('[waterline-mongo-modern] find error', collName, err.message);
        cb(err);
      });
  },

  create(connName, collName, values, cb) {
    const { db } = _connections[connName];
    // Don't store `id` — let MongoDB generate `_id`
    const { id, ...doc } = values;

    console.log('[waterline-mongo-modern] create', collName, JSON.stringify(doc).slice(0, 120));
    db.collection(collName).insertOne(doc)
      .then(result => {
        doc._id = result.insertedId;
        console.log('[waterline-mongo-modern] created', collName, doc._id.toString());
        cb(null, normalizeDoc(doc));
      })
      .catch(err => {
        console.error('[waterline-mongo-modern] create error', collName, err.message);
        cb(err);
      });
  },

  update(connName, collName, options, values, cb) {
    const { db } = _connections[connName];
    const filter = buildFilter(options.where);

    // Remove `id` from values to avoid overwriting `_id`
    const { id, _id, ...update } = values;

    db.collection(collName)
      .updateMany(filter, { $set: update })
      .then(() => db.collection(collName).find(filter).toArray())
      .then(docs => cb(null, docs.map(normalizeDoc)))
      .catch(cb);
  },

  destroy(connName, collName, options, cb) {
    const { db } = _connections[connName];
    const filter = buildFilter(options.where);

    db.collection(collName).find(filter).toArray()
      .then(docs => {
        const normalized = docs.map(normalizeDoc);
        return db.collection(collName).deleteMany(filter).then(() => normalized);
      })
      .then(deleted => cb(null, deleted))
      .catch(cb);
  },

  count(connName, collName, options, cb) {
    const { db } = _connections[connName];
    const filter = buildFilter(options.where);

    db.collection(collName).countDocuments(filter)
      .then(n => cb(null, n))
      .catch(cb);
  },
};
