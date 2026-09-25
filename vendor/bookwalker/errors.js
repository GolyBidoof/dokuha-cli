'use strict';

class CliError extends Error {
    constructor(message, code = 'BWDD_CLI_ERROR', details = null) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.details = details;
    }
}

class AutomationError extends CliError {
    constructor(message, details = null) {
        super(message, 'BWDD_AUTOMATION_ERROR', details);
    }
}

class AutomationUnavailableError extends AutomationError {
    constructor(message = 'window.__bwddAutomation.start() is unavailable. Update the BookWalker userscript with the automation API; the CLI will not scrape the GUI.') {
        super(message);
        this.code = 'BWDD_AUTOMATION_UNAVAILABLE';
    }
}

class BridgeError extends CliError {
    constructor(message, status = null, details = null) {
        super(message, 'BWDD_BRIDGE_ERROR', details);
        this.status = status;
    }
}

function errorMessage(error) {
    if (!error) return 'Unknown error';
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch (_) {
        return String(error);
    }
}

function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

function isLoginRequiredError(error) {
    const detail = error && error.details;
    const codes = [
        error && error.code,
        detail && detail.code,
        detail && detail.reason,
        detail && detail.automationCode,
        detail && detail.automationError
    ].filter(Boolean).map(value => String(value).toUpperCase());
    if (codes.some(code => /LOGIN|AUTH|UNAUTHORIZED|FORBIDDEN/.test(code))) return true;
    return /\blog[ _-]?in\b|\blogin[- _]required\b|\brequires? login\b|\bauthentication\b|\bunauthorized\b|\bnot authorized\b/i.test(errorMessage(error));
}

function isPublicRouteBlockedError(error) {
    const detail = error && error.details;
    const codes = [
        error && error.code,
        detail && detail.code,
        detail && detail.reason,
        detail && detail.automationCode,
        detail && detail.automationError,
        detail && detail.status
    ].filter(Boolean).map(value => String(value).toUpperCase());
    if (codes.some(code => /BWDD_AUTOMATION_UNAVAILABLE|AUTOMATION_API_MISSING/.test(code))) return false;
    if (codes.some(code => /PUBLIC|BOT|DRM|CHALLENGE|CAPTCHA|UNAVAILABLE|995/.test(code))) return true;
    return isLoginRequiredError(error) ||
        /anti[- ]?bot|bot protection|viewer protection|drm|challenge|captcha|gray|grey|session cookie expired|public sample.*unavailable|public configuration.*(?:403|forbidden|unavailable)|navigation timeout|viewer.*(?:failed|blocked)|status\s*(?:403|995)/i.test(errorMessage(error));
}

module.exports = {
    AutomationError,
    AutomationUnavailableError,
    BridgeError,
    CliError,
    errorMessage,
    isAbortError,
    isLoginRequiredError,
    isPublicRouteBlockedError
};
