'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');
const { UpstashGroupRepository, resolveRedisCredentials } = require('../lib/tablet-repository');

const apply = process.argv.includes('--apply');
const credentials = resolveRedisCredentials(process.env);

if (!credentials) {
  throw new Error('Production Redis credentials were not provided. Run with the pulled production environment file.');
}

const keys = Object.freeze({
  groups: 'riddle-groups:v1',
  tablets: 'riddle-tablets:v1',
  submissions: 'riddle-submissions:v1'
});

function recordCount(records) {
  return Object.values(records || {}).filter((record) => record && typeof record === 'object').length;
}

async function main() {
  const redis = new Redis({ ...credentials, enableTelemetry: false });
  const groups = new UpstashGroupRepository({ ...credentials, redis, key: keys.groups });

  const result = await groups.withMutationLock(async () => {
    const [groupRecords, tabletRecords, submissionRecords] = await Promise.all([
      redis.hgetall(keys.groups),
      redis.hgetall(keys.tablets),
      redis.hgetall(keys.submissions)
    ]);
    const snapshot = {
      version: 1,
      createdAt: new Date().toISOString(),
      keys,
      records: {
        groups: groupRecords || {},
        tablets: tabletRecords || {},
        submissions: submissionRecords || {}
      }
    };
    const serialized = JSON.stringify(snapshot, null, 2) + '\n';
    const timestamp = snapshot.createdAt.replace(/[-:.]/g, '');
    const backupDirectory = path.join(__dirname, '..', 'artifacts', 'production-backups');
    const backupPath = path.join(backupDirectory, `riddle-tablets-${timestamp}.json`);
    fs.mkdirSync(backupDirectory, { recursive: true });
    fs.writeFileSync(backupPath, serialized, { encoding: 'utf8', flag: 'wx' });

    const candidates = Object.entries(groupRecords || {}).filter(([, group]) => (
      group && typeof group === 'object' && group.completedAt && group.status !== 'archived'
    ));

    if (apply && candidates.length) {
      const now = Date.now();
      const writes = Object.fromEntries(candidates.map(([field, group]) => [field, {
        ...group,
        status: 'archived',
        updatedAt: now,
        archivedAt: group.archivedAt || now
      }]));
      await redis.hset(keys.groups, writes);
    }

    return {
      backupPath,
      checksum: crypto.createHash('sha256').update(serialized).digest('hex'),
      counts: {
        groups: recordCount(groupRecords),
        tablets: recordCount(tabletRecords),
        submissions: recordCount(submissionRecords)
      },
      candidates: candidates.map(([field, group]) => ({ id: group.id || field, status: group.status }))
    };
  });

  console.log(`Backup: ${result.backupPath}`);
  console.log(`SHA-256: ${result.checksum}`);
  console.log(`Records: ${result.counts.groups} groups, ${result.counts.tablets} tablets, ${result.counts.submissions} submissions`);
  console.log(`Completed groups requiring archival: ${result.candidates.length}`);
  result.candidates.forEach((candidate) => console.log(`- ${candidate.id}: ${candidate.status} -> archived`));
  console.log(apply ? 'Migration applied.' : 'Dry run only; no Redis records were changed.');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
