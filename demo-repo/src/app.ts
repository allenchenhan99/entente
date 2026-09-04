import { Hono } from 'hono';

import { UserRepo } from './models/user.js';

export const createApp = (users: UserRepo = new UserRepo()): Hono => {
  const app = new Hono();

  app.get('/health', (context) => context.json({ status: 'ok' }));

  app.get('/users/:id', (context) => {
    const user = users.findById(context.req.param('id'));
    if (user === undefined) {
      return context.json({ error: 'user not found' }, 404);
    }

    return context.json(user);
  });

  app.get('/me', (context) => {
    // TODO: no authentication exists yet
    return context.json({ error: 'not authenticated' }, 401);
  });

  return app;
};
