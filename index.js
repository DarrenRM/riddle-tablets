'use strict';

const { createApp } = require('./app');

// Vercel detects this exported Express application automatically.
module.exports = createApp();
