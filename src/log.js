// Dead-simple leveled logger. Keeps secrets out of platform logs.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const active = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

const stamp = () => new Date().toISOString().slice(11, 19);

const redact = (msg) =>
  String(msg).replace(/(session|token|password|secret|sig)=[^&\s"']+/gi, '$1=<redacted>');

function emit(level, args) {
  if (LEVELS[level] > active) return;
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${args.map(redact).join(' ')}`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
};
