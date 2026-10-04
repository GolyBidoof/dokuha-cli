/**
 * URL detection.
 *
 * The patterns live with the platform that owns them, in `src/platforms`; this
 * module is the name the rest of the code has always imported them by.
 */

export {
    canExpandSeries,
    detectSource,
    isSeriesPage,
    KINDLE_UNLIMITED_LABEL,
    platformFor,
    STORE_LABELS,
} from './platforms/index.js';
