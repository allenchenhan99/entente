export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export type NewUser = Pick<User, 'id' | 'email' | 'name'>;

export const seededUsers: readonly User[] = [
  {
    id: 'user-1',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  {
    id: 'user-2',
    email: 'grace@example.com',
    name: 'Grace Hopper',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
  },
];

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const cloneUser = (user: User): User => ({
  ...user,
  createdAt: new Date(user.createdAt.getTime()),
});

export class UserRepo {
  private readonly usersById = new Map<string, User>();
  private readonly userIdsByEmail = new Map<string, string>();

  constructor(
    users: readonly User[] = seededUsers,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const user of users) {
      this.insert(cloneUser(user));
    }
  }

  create(input: NewUser): User {
    if (this.usersById.has(input.id)) {
      throw new Error('user id already exists');
    }

    const email = normalizeEmail(input.email);
    if (this.userIdsByEmail.has(email)) {
      throw new Error('user email already exists');
    }

    const user: User = {
      ...input,
      email,
      createdAt: new Date(this.now().getTime()),
    };

    this.insert(user);
    return cloneUser(user);
  }

  findByEmail(email: string): User | undefined {
    const id = this.userIdsByEmail.get(normalizeEmail(email));
    return id === undefined ? undefined : this.findById(id);
  }

  findById(id: string): User | undefined {
    const user = this.usersById.get(id);
    return user === undefined ? undefined : cloneUser(user);
  }

  private insert(user: User): void {
    this.usersById.set(user.id, user);
    this.userIdsByEmail.set(normalizeEmail(user.email), user.id);
  }
}
