'use strict';

// Use an in-memory SQLite database for all tests.
// Must be set before any module that imports src/db.js is loaded.
process.env.DB_PATH = ':memory:';
