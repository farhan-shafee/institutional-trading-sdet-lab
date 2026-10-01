// Public synthetic credentials for this local lab; these are not secrets.
export const credentials = {
  trader: { username: 'qa.user', password: 'Password123!' },
  viewer: { username: 'qa.viewer', password: 'Password123!' },
} as const;

// Each login gets its own clone of these records. Never mutate another session.
export const seedIds = {
  newOrder: 'seed-new-aapl',
  partialOrder: 'seed-partial-msft',
  filledOrder: 'seed-filled-nvda',
  canceledOrder: 'seed-canceled-spy',
  rejectedOrder: 'seed-rejected-aapl',
} as const;
