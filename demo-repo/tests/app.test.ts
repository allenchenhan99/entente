import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { seededUsers } from '../src/models/user.js';

describe('HTTP app', () => {
  it('reports health', async () => {
    const response = await createApp().request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('returns a seeded user by id', async () => {
    const response = await createApp().request(`/users/${seededUsers[0].id}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ...seededUsers[0],
      createdAt: seededUsers[0].createdAt.toISOString(),
    });
  });

  it('returns 404 when a user is missing', async () => {
    const response = await createApp().request('/users/missing');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'user not found' });
  });

  it('reports that the current user is not authenticated', async () => {
    const response = await createApp().request('/me');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'not authenticated' });
  });
});
