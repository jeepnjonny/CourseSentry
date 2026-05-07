'use strict';

/**
 * Authentication middleware for Express routes.
 * Validates session and enforces role-based access control.
 */

/**
 * Middleware: Verify user is authenticated.
 * Requires valid session with user object.
 */
function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  }
  next();
}

/**
 * Middleware: Verify user has one of the required roles.
 * @param {string[]} roles - Allowed role names (e.g. 'admin', 'operator')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
