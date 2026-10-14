/**
 * The tuning seam.
 *
 * A store's cross-cutting values live on its platform descriptor, and the three
 * consumers that used to name stores read them from there. This test hands each
 * consumer a synthetic descriptor and asserts it is picked up without the
 * consumer changing, which is the property that makes a new store one file.
 *
 * The synthetic store is the only one this test needs. A real store already
 * covers the documented defaults in test_options.mjs.
 */

import fs from 'node:fs';

import { DEFAULTS, parseOptions, storeConcurrencyOptions } from '../src/options.js';
import { PLATFORMS, concurrencyContext, concurrencyDefaults, concurrencyPlatforms } from '../src/platforms/index.js';
import { allocateCpu } from '../src/cpu-budget.js';
import { check, checkEqual, finish } from './_harness.mjs';

// A store that exists only for this test. It declares the whole tuning shape: a
// page concurrency with its own flag and range, a CPU weight and slot, and the
// context field its adapter reads.
const SYNTHETIC = {
    name: 'Synthetic',
    id: 'synthetic',
    label: 'SYN',
    lane: 'net',
    hosts: ['synthetic.test'],
    patterns: [{
        re: /synthetic\.test\/(\d+)/i,
        kind: 'synthetic',
        build: (m, raw) => ({ kind: 'synthetic', volumeId: m[1], url: raw }),
    }],
    volumeId: (det) => det.volumeId ?? null,
    expand: () => false,
    download: async () => ({ store: 'synthetic' }),
    tuning: {
        concurrency: 7,
        contextKey: 'syntheticViewerConcurrency',
        cpuWeight: 0.5,
        cpuSlot: 'renderJobs',
        flag: {
            name: 'synthetic-concurrency',
            order: 99,
            max: 9,
            help: 'Synthetic pages in flight',
            hint: '; the trailing sentence survives the move',
        },
    },
};

const platforms = [...PLATFORMS, SYNTHETIC];

// ---------------------------------------------------------------------------
// Every real store is still the one source of its own tuning
// ---------------------------------------------------------------------------
{
    checkEqual('the registry is still the five stores',
        PLATFORMS.map((entry) => entry.id), ['kindle', 'cmoa', 'ebookjapan', 'bookwalker', 'kmanga']);
    check('every real store declares a tuning block',
        PLATFORMS.every((entry) => entry.tuning && Number(entry.tuning.cpuWeight) > 0),
        PLATFORMS.map((entry) => entry.id).join(', '));
    checkEqual('the real defaults are unchanged',
        [DEFAULTS.cmConcurrency, DEFAULTS.ebConcurrency, DEFAULTS.bwConcurrency, DEFAULTS.kdlConcurrency, DEFAULTS.kmConcurrency],
        [12, 32, 128, 12, 16]);
}

// ---------------------------------------------------------------------------
// options.js reads the descriptor: flag, default, range and shared override
// ---------------------------------------------------------------------------
{
    checkEqual('a descriptor concurrency becomes the parsed default',
        parseOptions([], { platforms }).config.syntheticConcurrency, 7);

    checkEqual('its flag is accepted and wins',
        parseOptions(['--synthetic-concurrency', '5'], { platforms }).config.syntheticConcurrency, 5);
    checkEqual('--concurrency still overrides every store',
        parseOptions(['--concurrency', '6'], { platforms }).config.syntheticConcurrency, 6);
    checkEqual('a specific flag still beats the shared one',
        parseOptions(['--concurrency', '6', '--synthetic-concurrency', '4'], { platforms }).config.syntheticConcurrency, 4);

    let above = null;
    try { parseOptions(['--synthetic-concurrency', '10'], { platforms }); } catch (error) { above = error; }
    check('the descriptor range is enforced', /1-9/.test(above?.message || ''), above?.message);
    checkEqual('the range boundary is accepted',
        parseOptions(['--synthetic-concurrency', '9'], { platforms }).config.syntheticConcurrency, 9);

    const option = storeConcurrencyOptions(platforms).find((entry) => entry.name === 'synthetic-concurrency');
    check('the generated flag carries the descriptor help',
        option?.help === 'Synthetic pages in flight (default 7); the trailing sentence survives the move',
        option?.help);
    checkEqual('the generated flags keep their order',
        storeConcurrencyOptions(platforms).map((entry) => entry.name),
        ['cm-concurrency', 'eb-concurrency', 'bw-concurrency', 'kdl-concurrency', 'km-concurrency', 'synthetic-concurrency']);
    checkEqual('the registry-derived defaults include the descriptor',
        concurrencyDefaults(platforms).syntheticConcurrency, 7);
}

// ---------------------------------------------------------------------------
// run.js fills the context through concurrencyContext
// ---------------------------------------------------------------------------
{
    const stored = concurrencyContext({
        cmConcurrency: 11, ebConcurrency: 22, bwConcurrency: 33, kdlConcurrency: 44, kmConcurrency: 55,
        syntheticConcurrency: 66,
    }, platforms);
    checkEqual('the descriptor contextKey is the field that is filled', stored.syntheticViewerConcurrency, 66);
    checkEqual('the real stores keep their own context fields',
        [stored.cmoaConcurrency, stored.ebConcurrency, stored.bwConcurrency, stored.kdlConcurrency, stored.kmConcurrency],
        [11, 22, 33, 44, 55]);
    checkEqual('no value is invented for an unset store',
        concurrencyContext({}, platforms).syntheticViewerConcurrency, undefined);
}

// ---------------------------------------------------------------------------
// cpu-budget.js reads the descriptor weight and slot
// ---------------------------------------------------------------------------
{
    const solo = allocateCpu({ cores: 20, active: { synthetic: 1 }, platforms });
    checkEqual('the descriptor cpuWeight drives the share', solo.renderJobs, 20);

    const split = allocateCpu({ cores: 20, active: { synthetic: 1, bookwalker: 1 }, platforms });
    check('a store with no cpuSlot still counts in the denominator',
        split.renderJobs > 0 && split.normalizeWorkers > 0, JSON.stringify(split));
    check('the two shares do not exceed the machine',
        split.renderJobs + split.normalizeWorkers <= 20,
        `${split.renderJobs} + ${split.normalizeWorkers}`);

    // A store that declares no tuning is the sensible default: no flag, no CPU
    // share, and no dilution of the stores that do declare one.
    const plain = { ...SYNTHETIC, id: 'plain', tuning: undefined };
    const withPlain = [...platforms, plain];
    check('a store with no tuning gets no concurrency flag',
        concurrencyPlatforms(withPlain).every((entry) => entry.id !== 'plain'));
    checkEqual('a store with no tuning does not dilute the budget',
        allocateCpu({ cores: 20, active: { plain: 4, synthetic: 1 }, platforms: withPlain }).renderJobs, 20);
}

// ---------------------------------------------------------------------------
// The consumers themselves name no store
// ---------------------------------------------------------------------------
{
    const budgetSource = fs.readFileSync(new URL('../src/cpu-budget.js', import.meta.url), 'utf8');
    check('cpu-budget names no store',
        !/['"](?:cmoa|bookwalker|ebookjapan|kmanga|kindle)['"]/.test(budgetSource),
        'cpu-budget.js still keys its weights by store name');

    const runSource = fs.readFileSync(new URL('../src/run.js', import.meta.url), 'utf8');
    const ctxBlock = /const ctx = \{([\s\S]*?)\n    \};/.exec(runSource);
    check('the driver builds concurrency from the registry',
        /concurrencyContext\(config/.test(ctxBlock ? ctxBlock[1] : ''),
        'run.js does not spread the registry-derived concurrency context');
}

finish();
