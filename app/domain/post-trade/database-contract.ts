import { liveMigrationChecksums } from '../workflow/live-database-contract.js';
export const postTradeProfile = 'owned-posttrade-v1' as const;
export const postTradeMigrationChecksums: ReadonlyArray<{ version: number; checksum: string }> = [
  ...liveMigrationChecksums,
  { version: 10, checksum: '797cdf8d9c1cbb61278e46d90d30ab00838492ab2b923491f2e5574b728095da' },
];
