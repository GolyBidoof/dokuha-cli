/**
 * Minimal test harness.
 *
 * Each test file is run in its own process by `run.mjs`. A file reports success by
 * exiting 0 after at least one check, having printed the `ALL n CHECKS PASSED`
 * line the runner looks for. That contract is copied from the sibling userscript
 * repo so both projects are driven the same way.
 */

let passed = 0;
let failed = 0;

/**
 * Assert a condition.
 *
 * @param {string} label what is being checked, phrased as a statement
 * @param {boolean} condition
 * @param {string} [detail] extra context printed on failure
 */
export function check(label, condition, detail = '') {
    if (condition) {
        passed++;
        return;
    }
    failed++;
    process.stderr.write(`FAIL  ${label}${detail ? `  (${detail})` : ''}\n`);
}

/** Assert two values are deeply equal, with a readable diff on failure. */
export function checkEqual(label, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    check(label, a === b, `got ${a}, want ${b}`);
}

/**
 * Print the summary and exit.
 *
 * A file that finishes with zero checks is treated as a failure: it almost always
 * means the assertions were never reached, and silently passing then is worse than
 * a red result.
 */
export function finish() {
    if (failed > 0) {
        process.stderr.write(`\n${failed} check(s) failed, ${passed} passed\n`);
        process.exit(1);
    }
    if (passed === 0) {
        process.stderr.write('\nno checks ran\n');
        process.exit(1);
    }
    process.stdout.write(`ALL ${passed} CHECKS PASSED\n`);
    process.exit(0);
}
