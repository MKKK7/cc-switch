const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
let currentLogLevel = 1; // default to info
export function initLogger(level) {
    const normalized = level.toLowerCase();
    if (normalized in LOG_LEVELS) {
        currentLogLevel = LOG_LEVELS[normalized];
    }
}
export const logger = {
    debug(msg, ...args) {
        if (currentLogLevel <= LOG_LEVELS.debug) {
            console.log(`[DEBUG] ${msg}`, ...args);
        }
    },
    info(msg, ...args) {
        if (currentLogLevel <= LOG_LEVELS.info) {
            console.log(`[INFO] ${msg}`, ...args);
        }
    },
    warn(msg, ...args) {
        if (currentLogLevel <= LOG_LEVELS.warn) {
            console.warn(`[WARN] ${msg}`, ...args);
        }
    },
    error(msg, ...args) {
        if (currentLogLevel <= LOG_LEVELS.error) {
            console.error(`[ERROR] ${msg}`, ...args);
        }
    },
};
//# sourceMappingURL=logger.js.map