import type pg from 'pg';
import { DomainError } from '../../domain/errors.js';
import { publicPostTradeProfileChecksum } from './posttrade-profile.js';

export const publicProfileChecksum =
  'cfa58430fe84656729eaf5fd0ed61db16da061927c619d9a336de4647dbbed32';

export type PublicProfileKind = 'workflow' | 'posttrade';

export async function verifyPublicProfile(
  db: pg.PoolClient | pg.Client,
  kind: PublicProfileKind = 'workflow',
): Promise<void> {
  const result = await db.query<{
    profile_name: string;
    profile_version: number;
    source_checksum: string;
    correct_database: boolean;
  }>(
    `SELECT profile_name,profile_version,source_checksum,
      database_name=current_database() AS correct_database
      FROM fi_control.public_demo_profile WHERE singleton`,
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.profile_name !== (kind === 'posttrade' ? 'public-posttrade-v1' : 'public-workflow-v1') ||
    row.profile_version !== 1 ||
    row.source_checksum !==
      (kind === 'posttrade' ? publicPostTradeProfileChecksum : publicProfileChecksum) ||
    !row.correct_database
  )
    throw new DomainError(
      503,
      'PUBLIC_DEMO_PROFILE_UNAVAILABLE',
      'Public demo persistence is unavailable.',
    );
}
