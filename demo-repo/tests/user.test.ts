import { describe, expect, it } from 'vitest';

import { seededUsers, UserRepo } from '../src/models/user.js';

describe('UserRepo', () => {
  it('starts with two users retrievable by id and normalized email', () => {
    const repo = new UserRepo();

    expect(seededUsers).toHaveLength(2);
    expect(repo.findById(seededUsers[0].id)).toEqual(seededUsers[0]);
    expect(repo.findByEmail(seededUsers[1].email.toUpperCase())).toEqual(seededUsers[1]);
  });

  it('creates a user with a normalized email and the injected creation time', () => {
    const createdAt = new Date('2026-09-04T08:00:00.000Z');
    const repo = new UserRepo([], () => createdAt);

    const user = repo.create({
      id: 'user-3',
      email: '  Lin@example.com ',
      name: 'Lin',
    });

    expect(user).toEqual({
      id: 'user-3',
      email: 'lin@example.com',
      name: 'Lin',
      createdAt,
    });
    expect(repo.findByEmail('LIN@EXAMPLE.COM')).toEqual(user);
  });

  it('rejects a duplicate id', () => {
    const repo = new UserRepo();

    expect(() =>
      repo.create({ id: seededUsers[0].id, email: 'new@example.com', name: 'New' }),
    ).toThrow('user id already exists');
  });

  it('rejects a duplicate normalized email', () => {
    const repo = new UserRepo();

    expect(() =>
      repo.create({ id: 'user-3', email: ` ${seededUsers[0].email.toUpperCase()} `, name: 'New' }),
    ).toThrow('user email already exists');
  });
});
