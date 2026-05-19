'use strict';

/**
 * User Management Routes
 *
 * This module provides administrative endpoints for managing user accounts in the CourseSentry system.
 * It handles user creation, updates, deletion, and listing with proper role-based access control.
 *
 * Key Features:
 * - User CRUD operations with role validation
 * - Password hashing using bcrypt
 * - Callsign management (uppercase, trimmed)
 * - Protection against self-deletion
 * - Comprehensive logging of user management actions
 * - Role-based authorization (admin only)
 */

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireRole } = require('../auth');
const logger = require('../logger');

const router = express.Router();

/**
 * GET / - Retrieves all users
 * Requires admin role
 * @returns {Object} JSON response with users array (excluding password hashes)
 */
router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, username, role, callsign, phone, color, shape, created_at FROM users').all();
  res.json({ ok: true, data: users });
});

/**
 * POST / - Creates a new user account
 * Requires admin role
 * @param {string} req.body.username - Username (required)
 * @param {string} req.body.password - Password (required)
 * @param {string} req.body.role - User role: 'admin', 'operator', or 'station' (required)
 * @param {string} [req.body.callsign] - Optional callsign
 * @returns {Object} JSON response with created user data
 */
router.post('/', requireRole('admin'), async (req, res) => {
  const { username, password, role, callsign, phone, color, shape } = req.body;

  if (!username || !password || !['admin', 'operator', 'station'].includes(role)) {
    return res.status(400).json({
      ok: false,
      error: 'username, password, and role (admin|operator|station) required'
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const normalizedCallsign = callsign?.toUpperCase().trim() || null;

    const result = db.prepare(
      'INSERT INTO users (username, password_hash, role, callsign, phone, color, shape) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(username, passwordHash, role, normalizedCallsign,
      phone?.trim() || null, color || '#f5a623', shape || 'triangle');

    logger.log('system', 'info', `User created — ${username} (${role}) by ${req.session.user.username}`);

    res.json({
      ok: true,
      data: {
        id: result.lastInsertRowid,
        username, role,
        callsign: normalizedCallsign,
        phone: phone?.trim() || null,
        color: color || '#f5a623',
        shape: shape || 'triangle',
      }
    });
  } catch (error) {
    res.status(409).json({ ok: false, error: 'Username already exists' });
  }
});

/**
 * PUT /:id - Updates an existing user account
 * Requires admin role
 * @param {number} req.params.id - User ID
 * @param {string} [req.body.username] - New username
 * @param {string} [req.body.password] - New password
 * @param {string} [req.body.role] - New role
 * @param {string} [req.body.callsign] - New callsign (null to clear)
 * @returns {Object} JSON response with updated user data
 */
router.put('/:id', requireRole('admin'), async (req, res) => {
  const { username, password, role, callsign, phone, color, shape } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }

  const newUsername = username || user.username;
  const newRole = role || user.role;
  const newCallsign = callsign !== undefined ? (callsign?.toUpperCase().trim() || null) : user.callsign;
  const newPhone = phone !== undefined ? (phone?.trim() || null) : user.phone;
  const newColor = color ?? user.color ?? '#f5a623';
  const newShape = shape ?? user.shape ?? 'triangle';
  const newPasswordHash = password ? await bcrypt.hash(password, 10) : user.password_hash;

  db.prepare(
    'UPDATE users SET username=?, password_hash=?, role=?, callsign=?, phone=?, color=?, shape=? WHERE id=?'
  ).run(newUsername, newPasswordHash, newRole, newCallsign, newPhone, newColor, newShape, req.params.id);

  const changes = [];
  if (newUsername !== user.username) changes.push(`username→${newUsername}`);
  if (newRole !== user.role) changes.push(`role→${newRole}`);
  if (newCallsign !== user.callsign) changes.push(`callsign→${newCallsign || 'cleared'}`);
  if (password) changes.push('password changed');

  logger.log('system', 'info',
    `User updated — ${newUsername}${changes.length ? ` (${changes.join(', ')})` : ''} by ${req.session.user.username}`
  );

  res.json({
    ok: true,
    data: {
      id: user.id,
      username: newUsername, role: newRole,
      callsign: newCallsign, phone: newPhone,
      color: newColor, shape: newShape,
    }
  });
});

/**
 * DELETE /:id - Deletes a user account
 * Requires admin role. Prevents self-deletion.
 * @param {number} req.params.id - User ID
 * @returns {Object} JSON response confirming deletion
 */
router.delete('/:id', requireRole('admin'), (req, res) => {
  // Prevent users from deleting their own accounts
  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ ok: false, error: 'Cannot delete your own account' });
  }

  const targetUser = db.prepare('SELECT username, role FROM users WHERE id=?').get(req.params.id);
  const result = db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);

  if (!result.changes) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }

  if (targetUser) {
    logger.log('system', 'warn',
      `User deleted — ${targetUser.username} (${targetUser.role}) by ${req.session.user.username}`
    );
  }

  res.json({ ok: true });
});

module.exports = router;
