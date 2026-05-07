'use strict';

/**
 * CSV file library for race imports and previews.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'csv');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `csv_${Date.now()}.csv`),
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, path.extname(file.originalname).toLowerCase() === '.csv'),
});

router.get('/', requireAuth, (req, res) => {
  const files = db.prepare('SELECT * FROM csv_files ORDER BY created_at DESC').all();
  res.json({ ok: true, data: files });
});

router.post('/upload', requireRole('admin'), upload.single('csv'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'no file uploaded' });
  }

  const name = path.basename(req.file.originalname, '.csv');
  const result = db.prepare('INSERT INTO csv_files (name, file_path) VALUES (?, ?)').run(name, req.file.path);
  const file = db.prepare('SELECT * FROM csv_files WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ok: true, data: file });
});

router.get('/:id/preview', requireAuth, (req, res) => {
  const file = db.prepare('SELECT * FROM csv_files WHERE id = ?').get(req.params.id);
  if (!file) {
    return res.status(404).json({ ok: false, error: 'file not found' });
  }

  try {
    const text = fs.readFileSync(file.file_path, 'utf8');
    const lines = text.trim().split(/\r?\n/).slice(0, 6);
    const totalRows = Math.max(0, text.trim().split(/\r?\n/).length - 1);
    res.json({ ok: true, data: { lines, total: totalRows } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const file = db.prepare('SELECT * FROM csv_files WHERE id = ?').get(req.params.id);
  if (!file) {
    return res.status(404).json({ ok: false, error: 'file not found' });
  }

  if (req.body.name) {
    db.prepare('UPDATE csv_files SET name = ? WHERE id = ?').run(req.body.name, req.params.id);
  }

  res.json({ ok: true, data: db.prepare('SELECT * FROM csv_files WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const file = db.prepare('SELECT * FROM csv_files WHERE id = ?').get(req.params.id);
  if (!file) {
    return res.status(404).json({ ok: false, error: 'file not found' });
  }

  try {
    fs.unlinkSync(file.file_path);
  } catch (_error) {}

  db.prepare('DELETE FROM csv_files WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
