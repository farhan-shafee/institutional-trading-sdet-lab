import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { releaseConfigurationSchema } from './public-demo-release-config.js';
import { loadPrivate, savePrivate } from './private-state.js';
import { readConfiguration } from '../app/server/configuration.js';
import { publicPostTradeProfileChecksum } from '../app/server/public-demo/posttrade-profile.js';

/** Offline-only, explicit new-profile envelope. Original public-v1 journals stay unchanged. */
export const publicPostTradeReleaseSchema = z
  .object({
    version: z.literal(2),
    profile: z.literal('public-posttrade-v1'),
    profileChecksum: z.literal(publicPostTradeProfileChecksum),
    databaseImageDirectory: z.literal('deployment/posttrade-postgres'),
    release: releaseConfigurationSchema,
    applicationEnvironment: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine((data, ctx) => {
    const expected = { ...data.release.applicationEnvironment, TRADEFLOW_PUBLIC_POSTTRADE: 'on' };
    const entries = (value: Record<string, string>) =>
      JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    try {
      if (
        data.release.phase !== 'CA_SUPPLIED' ||
        entries(data.applicationEnvironment) !== entries(expected) ||
        !readConfiguration(data.applicationEnvironment).publicDemo?.postTrade
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Explicit CA-bound public post-trade release configuration is required.',
      });
    }
  });

export async function sealPublicPostTradeRelease(original: string, target: string): Promise<void> {
  const release = releaseConfigurationSchema.parse(await loadPrivate(original));
  await savePrivate(
    target,
    publicPostTradeReleaseSchema.parse({
      version: 2,
      profile: 'public-posttrade-v1',
      profileChecksum: publicPostTradeProfileChecksum,
      databaseImageDirectory: 'deployment/posttrade-postgres',
      release,
      applicationEnvironment: {
        ...release.applicationEnvironment,
        TRADEFLOW_PUBLIC_POSTTRADE: 'on',
      },
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2) throw new Error('Expected two private paths.');
    await sealPublicPostTradeRelease(args[0]!, args[1]!);
    console.log('Private public post-trade release journal sealed; no provider action performed.');
  } catch {
    console.error('Public post-trade release journal refused; original material preserved.');
    process.exitCode = 1;
  }
}
