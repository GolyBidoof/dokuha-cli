/**
 * The ebookjapan page rebuild: draw-list recording and tile placement.
 *
 * The placement is the part that was wrong first time round and is easy to get
 * wrong again, so it is pinned against a hand-built case rather than only against
 * a live title. The failure it guards against is quiet: an off-by-one or a
 * reversed rotation still produces a full-size image of plausible-looking pixels,
 * just with a seam along every tile edge. So the assertions below check *which
 * source pixel lands where*, not merely that something was written.
 */

import { blitTiles, planComposition, recordShuffle } from '../src/download/ebj-descramble.js';
import { check, checkEqual, finish } from './_harness.mjs';

/** A glue whose `shuffle` replays a fixed script of context calls. */
function scriptedGlue(script) {
    return {
        shuffle(call) {
            for (const step of script) {
                if (step[0] === 'rotate') call.ctx.rotate(step[1]);
                else if (step[0] === 'reset') call.ctx.setTransform(1, 0, 0, 1, 0, 0);
                else if (step[0] === 'draw') call.ctx.drawImage({}, ...step.slice(1));
                else call.ctx[step[0]](...step.slice(1));
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

{
    const glue = scriptedGlue([
        ['rotate', Math.PI / 2],
        ['draw', 10, 20, 4, 4, 1, 2, 4, 4],
        ['reset'],
        ['draw', 0, 0, 4, 4, 0, 0, 4, 4],
    ]);
    const { ops, unknown } = recordShuffle(glue, 3, { width: 100, height: 200 });
    checkEqual('rotate and reset are both recorded', ops.map((o) => o.t), ['rotate', 'draw', 'reset', 'draw']);
    checkEqual('the draw keeps all eight numbers',
        [ops[1].sx, ops[1].sy, ops[1].sw, ops[1].sh, ops[1].dx, ops[1].dy, ops[1].dw, ops[1].dh],
        [10, 20, 4, 4, 1, 2, 4, 4]);
    checkEqual('a fully implemented context reports nothing unknown', unknown, []);
}

// Nothing in the script above touches another method, so a page that does must be
// reported rather than silently mis-composed.
{
    const glue = scriptedGlue([['clearRect', 0, 0, 10, 10], ['draw', 0, 0, 2, 2, 0, 0, 2, 2]]);
    const { unknown } = recordShuffle(glue, 0, { width: 10, height: 10 });
    checkEqual('an unimplemented context call is reported', unknown, ['clearRect/4']);
}

// ---------------------------------------------------------------------------
// Planning: the transform has to be tracked across draws
// ---------------------------------------------------------------------------

{
    // Two tiles, the second drawn after a quarter turn and then reset.
    const ops = [
        { t: 'draw', sx: 0, sy: 0, sw: 2, sh: 2, dx: 0, dy: 0, dw: 2, dh: 2 },
        { t: 'rotate', angle: Math.PI / 2 },
        { t: 'draw', sx: 0, sy: 0, sw: 2, sh: 2, dx: 2, dy: 0, dw: 2, dh: 2 },
        { t: 'reset' },
        { t: 'draw', sx: 0, sy: 0, sw: 2, sh: 2, dx: 0, dy: 2, dw: 2, dh: 2 },
    ];
    const plan = planComposition(ops);
    checkEqual('a quarter turn is tracked, not the running draw', plan.tiles.map((t) => t.turn), [0, 1, 0]);
    // Under R(pi/2) the square [2,4)x[0,2) lands on [-2,0)x[2,4), so the canvas
    // has to grow to the left and the union spans x from -2 to 2, y from 0 to 4.
    checkEqual('the canvas is the union of the rotated boxes',
        [plan.width, plan.height, plan.minX, plan.minY], [4, 4, -2, 0]);
    checkEqual('the rotated tile is placed at its rotated origin',
        [plan.tiles[1].x0, plan.tiles[1].y0], [-2, 2]);
}

{
    const plan = planComposition([]);
    checkEqual('a page with no draws plans nothing', [plan.width, plan.height, plan.tiles.length], [0, 0, 0]);
}

// ---------------------------------------------------------------------------
// Placement: which source pixel lands where
// ---------------------------------------------------------------------------

/** A 2x2 source whose pixels are named, one byte per pixel. */
function namedSource() {
    return { pixels: Buffer.from([1, 2, 3, 4]), info: { width: 2, height: 2, channels: 1 } };
}

{
    // No rotation: the tile is copied through unchanged.
    const plan = planComposition([{ t: 'draw', sx: 0, sy: 0, sw: 2, sh: 2, dx: 0, dy: 0, dw: 2, dh: 2 }]);
    const { pixels, info } = namedSource();
    checkEqual('an unrotated tile is copied through', [...blitTiles(pixels, info, plan)], [1, 2, 3, 4]);
}

{
    // One tile per turn, each positioned so the *rotated* box lands on the origin
    // (the module normally emits negative coordinates and lets the canvas grow).
    // That makes the expected pixel order something a reader can check by hand
    // rather than something only the implementation agrees with.
    //
    //   turn 0  copy                          [1,2,3,4]
    //   turn 1  quarter turn clockwise        [3,1,4,2]   ( 1 2 -> 3 1 )
    //   turn 2  half turn                     [4,3,2,1]   ( 3 4 -> 4 2 )
    //   turn 3  three quarters                [2,4,1,3]
    const at = {
        0: { dx: 0, dy: 0 },
        1: { dx: 0, dy: -2 },
        2: { dx: -2, dy: -2 },
        3: { dx: -2, dy: 0 },
    };
    const expected = { 0: [1, 2, 3, 4], 1: [3, 1, 4, 2], 2: [4, 3, 2, 1], 3: [2, 4, 1, 3] };
    const seen = [];

    for (const turn of [0, 1, 2, 3]) {
        const { dx, dy } = at[turn];
        const ops = [];
        if (turn) ops.push({ t: 'rotate', angle: (turn * Math.PI) / 2 });
        ops.push({ t: 'draw', sx: 0, sy: 0, sw: 2, sh: 2, dx, dy, dw: 2, dh: 2 });

        const plan = planComposition(ops);
        checkEqual(`turn ${turn} plans a 2x2 canvas at the origin`,
            [plan.width, plan.height, plan.minX, plan.minY], [2, 2, 0, 0]);

        const { pixels, info } = namedSource();
        const out = [...blitTiles(pixels, info, plan, { width: 2, height: 2 })];
        checkEqual(`turn ${turn} places the source pixels correctly`, out, expected[turn]);
        seen.push(out.join(''));
    }

    checkEqual('all four turns are distinct arrangements', new Set(seen).size, 4);
}

// Pixels outside the requested box are dropped rather than wrapping or throwing.
{
    const plan = planComposition([{ t: 'draw', sx: 0, sy: 0, sw: 2, sh: 2, dx: 0, dy: 0, dw: 2, dh: 2 }]);
    const { pixels, info } = namedSource();
    const out = blitTiles(pixels, info, plan, { width: 1, height: 1 });
    checkEqual('the box crops the tile', [...out], [1]);
}

// A source rectangle that runs off the edge must be skipped, not read out of
// bounds -- wasm emits the last column and row of the grid as full-size tiles.
{
    const plan = planComposition([{ t: 'draw', sx: 1, sy: 1, sw: 2, sh: 2, dx: 0, dy: 0, dw: 2, dh: 2 }]);
    const { pixels, info } = namedSource();
    const out = blitTiles(pixels, info, plan, { width: 2, height: 2 });
    checkEqual('an out-of-range source pixel reads as empty, not garbage', [...out], [4, 0, 0, 0]);
}

finish();
