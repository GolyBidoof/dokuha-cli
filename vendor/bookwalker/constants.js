'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const CLI_VERSION = '1.0.0';
const AUTOMATION_PROTOCOL_VERSION = 1;
const DEFAULT_QUEUE_PATH = process.env.BWDD_CLI_QUEUE ||
    path.join(os.homedir(), '.bwdd-cli', 'jobs.json');
const DEFAULT_PROFILE_DIR = process.env.BWDD_CLI_PROFILE ||
    path.join(os.homedir(), '.bwdd-cli', 'profile');
// This CLI drives the userscript, which lives in the sibling repo rather than
// here. `BWDD_US` (or --script) overrides it; the default assumes the two
// projects are checked out side by side.
// The repo was renamed at v2.0.0, so try the new directory name first and fall
// back to the old one: a checkout that predates the rename still works.
const SIBLING_REPO_DIRS = ['bookwalker-ebookjapan-cmoa-native-downloader', 'bookwalker-native-downloader'];
const SIBLING_REPO_SCRIPT = SIBLING_REPO_DIRS
    .map(d => path.resolve(__dirname, '..', '..', d, 'omnimanga-native-downloader.user.js'))
    .find(p => fs.existsSync(p)) ||
    path.resolve(__dirname, '..', '..', SIBLING_REPO_DIRS[0], 'omnimanga-native-downloader.user.js');
const DEFAULT_SCRIPT_PATH = process.env.BWDD_US || SIBLING_REPO_SCRIPT;
const DEFAULT_OUTPUT_DIR = process.env.BWDD_CLI_OUTPUT ||
    path.resolve(__dirname, '..', 'output');
const DEFAULT_BRIDGE_URL = process.env.BWDD_BRIDGE_URL ||
    'http://127.0.0.1:62642';
const MAX_CONCURRENCY = 16;
const DEFAULT_CONCURRENCY_CAP = 10;
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(MAX_CONCURRENCY, Number(process.env.BWDD_CLI_CONCURRENCY) || 2));
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15000;
const DEFAULT_AUTOMATION_TIMEOUT_MS = 120000;
const DEFAULT_BROWSER_RETRIES = 1;

const JOB_STATES = Object.freeze({
    PENDING: 'pending',
    RUNNING: 'running',
    PENDING_FINALIZE: 'pending_finalize',
    FINALIZING: 'finalizing',
    COMPLETED: 'completed',
    UNAVAILABLE: 'unavailable',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
});

const STATES = Object.freeze(Object.values(JOB_STATES));
const TERMINAL_STATES = new Set([
    JOB_STATES.COMPLETED,
    JOB_STATES.UNAVAILABLE,
    JOB_STATES.FAILED,
    JOB_STATES.CANCELLED
]);

module.exports = {
    AUTOMATION_PROTOCOL_VERSION,
    CLI_VERSION,
    DEFAULT_BRIDGE_URL,
    DEFAULT_CONCURRENCY,
    DEFAULT_CONCURRENCY_CAP,
    DEFAULT_NAVIGATION_TIMEOUT_MS,
    DEFAULT_AUTOMATION_TIMEOUT_MS,
    DEFAULT_BROWSER_RETRIES,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_PROFILE_DIR,
    DEFAULT_QUEUE_PATH,
    DEFAULT_SCRIPT_PATH,
    JOB_STATES,
    MAX_CONCURRENCY,
    STATES,
    TERMINAL_STATES
};
