import { migrationChecksums } from './database-contract.js';

export const liveProfile = 'live-fix-ingress-v1' as const;
export const liveMigrationChecksums: ReadonlyArray<{ version: number; checksum: string }> = [
  ...migrationChecksums,
  { version: 9, checksum: '3663e6c9d99d98886e3ce9a24ef7f76c85eba6adbd57d1711b453d3e272f2ec7' },
];
