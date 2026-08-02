'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const app = createApp();

app.listen(port, '127.0.0.1', () => {
  console.log(`Riddle Tablets listening on http://127.0.0.1:${port}`);
  if (!process.env.CREATE_PASSWORD) {
    console.log('The /create page is locked until CREATE_PASSWORD is set in .env.');
  }
});
