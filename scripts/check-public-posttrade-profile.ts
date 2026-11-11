import { validatePublicPostTradeProfileSources } from './validate-public-posttrade-profile.js';

await validatePublicPostTradeProfileSources();
console.log(
  'Public post-trade profile and original migration hashes match their declared contracts.',
);
