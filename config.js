'use strict';

// The only reader of process.env. Errors name the variable, never its value.

function num(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`);
  return v;
}

function loadConfig(env = process.env) {
  if (!env.RECORDER_SECRET) throw new Error('RECORDER_SECRET is required');
  return {
    secret: env.RECORDER_SECRET,
    dataDir: env.DATA_DIR || '/data/meet',
    port: num(env, 'PORT', 8080),
    displayName: env.BOT_DISPLAY_NAME || 'NoteTaker',
    // A link sent before the call keeps re-knocking for this long.
    joinTimeoutS: num(env, 'JOIN_TIMEOUT_S', 1200),
    maxDurationS: num(env, 'MAX_DURATION_S', 14400),
    emptyGraceS: num(env, 'EMPTY_GRACE_S', 60),
    logLevel: env.LOG_LEVEL || 'info',
  };
}

module.exports = { loadConfig };
