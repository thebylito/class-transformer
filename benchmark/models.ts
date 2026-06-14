/**
 * Representative model classes exercising the main class-transformer features:
 * @Expose (with rename), @Exclude, @Type (nested + arrays), @Transform, groups.
 */
import { Expose, Exclude, Type, Transform } from '../src';

/* -------------------------------------------------------------------------- */
/*  Plain / structural models (no decorators) — the most common usage         */
/* -------------------------------------------------------------------------- */

export class FlatUser {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  age: number;
  active: boolean;
  score: number;
  city: string;
  country: string;
  bio: string;
}

export function makeFlatUser(i: number): Record<string, any> {
  return {
    id: i,
    firstName: `First${i}`,
    lastName: `Last${i}`,
    email: `user${i}@example.com`,
    age: 20 + (i % 50),
    active: i % 2 === 0,
    score: i * 1.5,
    city: `City${i % 100}`,
    country: `Country${i % 30}`,
    bio: `${'Lorem ipsum dolor sit amet '.repeat(2)}${i}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Decorated / nested models — full feature surface                          */
/* -------------------------------------------------------------------------- */

export class Photo {
  @Expose() id: number;
  @Expose() filename: string;
  @Expose()
  @Transform(({ value }) => (typeof value === 'number' ? value * 2 : value))
  views: number;
}

export class Author {
  @Expose() firstName: string;
  @Expose() lastName: string;
  @Expose({ name: 'email_address' }) email: string;
  @Exclude() password: string;

  @Expose({ groups: ['admin'] })
  internalId: number;
}

export class Post {
  @Expose() id: number;
  @Expose() title: string;
  @Expose() body: string;

  @Type(() => Date)
  createdAt: Date;

  @Type(() => Author)
  author: Author;

  @Type(() => Photo)
  photos: Photo[];

  @Expose() tags: string[];
}

export function makePostPlain(i: number): Record<string, any> {
  return {
    id: i,
    title: `Title ${i}`,
    body: `${'Body content '.repeat(3)}${i}`,
    createdAt: '2020-01-01T00:00:00.000Z',
    author: {
      firstName: `First${i}`,
      lastName: `Last${i}`,
      email_address: `author${i}@example.com`,
      password: 'secret',
      internalId: i,
    },
    photos: [
      { id: i * 10 + 1, filename: 'a.jpg', views: 100 },
      { id: i * 10 + 2, filename: 'b.jpg', views: 200 },
      { id: i * 10 + 3, filename: 'c.jpg', views: 300 },
    ],
    tags: ['tag1', 'tag2', 'tag3', 'tag4'],
  };
}
