'use strict';

const fs = require('fs');
const path = require('path');

const dataDirectory = path.join(__dirname, '..', 'data');
const files = [
  ['groups.local.json', { version: 1, groups: [] }],
  ['tablets.local.json', { version: 1, tablets: [] }],
  ['submissions.local.json', { version: 1, submissions: [] }]
];

fs.mkdirSync(dataDirectory, { recursive: true });
files.forEach(([name, value]) => {
  const filePath = path.join(dataDirectory, name);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
});

console.log('Local test database reset. Production Redis was not accessed.');
