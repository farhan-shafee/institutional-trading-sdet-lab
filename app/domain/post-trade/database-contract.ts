import { liveMigrationChecksums } from '../workflow/live-database-contract.js';
export const postTradeProfile = 'owned-posttrade-v1' as const;
export const postTradeMigrationChecksums: ReadonlyArray<{ version: number; checksum: string }> = [
  ...liveMigrationChecksums,
  { version: 10, checksum: 'bf8e020e087989271640427b070dac83a0ee0ecb6b0b9c9b14321232d2b3cf77' },
];
