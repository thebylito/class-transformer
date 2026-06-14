import 'reflect-metadata';
import { Exclude, Expose, plainToInstance, Transform, Type } from '../../src';
import { clearCompiledPlans, getCompiledPlanPlainToClass, setCompilationEnabled } from '../../src/CompiledTransform';

/**
 * The compiled PLAIN_TO_CLASS fast path must produce output that is byte-for-byte
 * identical to the generic transform. Every case below transforms the same input
 * twice — once with compilation on, once off — and asserts strict deep equality
 * (which also checks instance types, `undefined` fields and sparse arrays).
 */
describe('compiled fast path ≡ generic transform', () => {
  afterEach(() => setCompilationEnabled(true));

  function assertEquivalent(cls: any, data: any): any {
    setCompilationEnabled(true);
    const compiled = plainToInstance(cls, data);
    setCompilationEnabled(false);
    const generic = plainToInstance(cls, data);
    setCompilationEnabled(true);
    expect(compiled).toStrictEqual(generic);
    return compiled;
  }

  it('exercises the fast path for simple classes (sanity: plan is not null)', () => {
    class Simple {
      @Expose() a: number;
    }
    // touch metadata so the plan can be built, then assert it compiled
    plainToInstance(Simple, { a: 1 });
    expect(getCompiledPlanPlainToClass(Simple)).not.toBeNull();
  });

  it('flat scalars', () => {
    class User {
      @Expose() id: number;
      @Expose() name: string;
      @Expose() active: boolean;
    }
    assertEquivalent(User, { id: 1, name: 'a', active: true });
  });

  it('@Expose rename', () => {
    class User {
      @Expose({ name: 'user_name' }) name: string;
      @Expose() id: number;
    }
    assertEquivalent(User, { user_name: 'bob', id: 2 });
  });

  it('@Exclude drops the property', () => {
    class User {
      @Expose() id: number;
      @Exclude() password: string;
    }
    const r = assertEquivalent(User, { id: 1, password: 'secret' });
    expect(r).not.toHaveProperty('password');
  });

  it('@Type Date', () => {
    class Event {
      @Type(() => Date) when: Date;
    }
    const r = assertEquivalent(Event, { when: '2020-01-02T03:04:05.000Z' });
    expect(r.when).toBeInstanceOf(Date);
  });

  it('@Type nested class', () => {
    class Address {
      @Expose() city: string;
    }
    class User {
      @Expose() id: number;
      @Type(() => Address) address: Address;
    }
    const r = assertEquivalent(User, { id: 1, address: { city: 'NYC' } });
    expect(r.address).toBeInstanceOf(Address);
  });

  it('@Type array of nested classes', () => {
    class Tag {
      @Expose() label: string;
    }
    class Post {
      @Type(() => Tag) tags: Tag[];
    }
    const r = assertEquivalent(Post, { tags: [{ label: 'x' }, { label: 'y' }] });
    expect(r.tags[0]).toBeInstanceOf(Tag);
    expect(r.tags).toHaveLength(2);
  });

  it('@Transform', () => {
    class User {
      @Transform(({ value }) => String(value).toUpperCase())
      name: string;
    }
    const r = assertEquivalent(User, { name: 'bob' });
    expect(r.name).toBe('BOB');
  });

  it('@Transform toClassOnly / toPlainOnly', () => {
    class User {
      @Transform(({ value }) => value + '_class', { toClassOnly: true })
      @Transform(({ value }) => value + '_plain', { toPlainOnly: true })
      name: string;
    }
    const r = assertEquivalent(User, { name: 'x' });
    expect(r.name).toBe('x_class');
  });

  it('inheritance (base-class decorators)', () => {
    class Base {
      @Transform(({ value }) => String(value).toUpperCase()) name: string;
      @Type(() => Date) createdAt: Date;
    }
    class Derived extends Base {
      @Expose() extra: string;
    }
    const r = assertEquivalent(Derived, { name: 'joe', createdAt: '2020-01-01T00:00:00.000Z', extra: 'e' });
    expect(r.name).toBe('JOE');
    expect(r.createdAt).toBeInstanceOf(Date);
  });

  it('missing fields (exposeUnsetFields default true)', () => {
    class User {
      @Expose() id: number;
      @Expose() name: string;
    }
    const r = assertEquivalent(User, { id: 1 }); // name missing
    expect(r).toHaveProperty('name');
    expect(r.name).toBeUndefined();
  });

  it('extraneous source fields are copied (exposeAll)', () => {
    class User {
      @Expose() id: number;
    }
    const r = assertEquivalent(User, { id: 1, extra: 'kept', nested: { a: 1 } });
    expect((r as any).extra).toBe('kept');
  });

  it('null and undefined values', () => {
    class User {
      @Expose() a: any;
      @Type(() => Date) b: Date;
      @Type(() => Date) c: Date;
    }
    assertEquivalent(User, { a: null, b: null, c: undefined });
  });

  it('untyped nested object is deep-copied (not shared)', () => {
    class Wrap {
      @Expose() data: any;
    }
    const input = { data: { x: 1, y: [1, 2] } };
    const r = assertEquivalent(Wrap, input);
    expect(r.data).not.toBe(input.data);
    expect(r.data.y).not.toBe(input.data.y);
  });

  it('untyped scalar array is copied (not shared)', () => {
    class Wrap {
      @Expose() tags: string[];
    }
    const input = { tags: ['a', 'b'] };
    const r = assertEquivalent(Wrap, input);
    expect(r.tags).not.toBe(input.tags);
    expect(r.tags).toEqual(['a', 'b']);
  });

  it('array input at the top level', () => {
    class User {
      @Expose() id: number;
      @Type(() => Date) when: Date;
    }
    setCompilationEnabled(true);
    const compiled = plainToInstance(User, [
      { id: 1, when: '2020-01-01T00:00:00.000Z' },
      { id: 2, when: '2021-01-01T00:00:00.000Z' },
    ]);
    setCompilationEnabled(false);
    const generic = plainToInstance(User, [
      { id: 1, when: '2020-01-01T00:00:00.000Z' },
      { id: 2, when: '2021-01-01T00:00:00.000Z' },
    ]);
    setCompilationEnabled(true);
    expect(compiled).toStrictEqual(generic);
    expect(compiled[0]).toBeInstanceOf(User);
  });

  it('does not overwrite prototype methods / getters', () => {
    class User {
      @Expose() id: number;
      get computed(): string {
        return 'getter';
      }
      greet(): string {
        return 'hi';
      }
    }
    const r = assertEquivalent(User, { id: 1, computed: 'OVERWRITE', greet: 'OVERWRITE' });
    expect(r.computed).toBe('getter');
    expect(typeof r.greet).toBe('function');
  });

  it('deeply nested mixed structure', () => {
    class Photo {
      @Expose() id: number;
      @Transform(({ value }) => (typeof value === 'number' ? value * 2 : value)) views: number;
    }
    class Author {
      @Expose() firstName: string;
      @Expose({ name: 'email_address' }) email: string;
      @Exclude() password: string;
    }
    class Post {
      @Expose() id: number;
      @Type(() => Date) createdAt: Date;
      @Type(() => Author) author: Author;
      @Type(() => Photo) photos: Photo[];
      @Expose() tags: string[];
    }
    const r = assertEquivalent(Post, {
      id: 7,
      createdAt: '2020-05-05T00:00:00.000Z',
      author: { firstName: 'A', email_address: 'a@b.c', password: 'p' },
      photos: [
        { id: 1, filename: 'a', views: 10 },
        { id: 2, filename: 'b', views: 20 },
      ],
      tags: ['t1', 't2'],
    });
    expect(r.author).toBeInstanceOf(Author);
    expect(r.author).not.toHaveProperty('password');
    expect(r.photos[0]).toBeInstanceOf(Photo);
    expect(r.photos[0].views).toBe(20);
    expect(r.createdAt).toBeInstanceOf(Date);
  });

  it('plans can be rebuilt after the cache is cleared (still equivalent)', () => {
    class Tmp {
      @Expose() a: number;
      @Transform(({ value }) => value + 1) b: number;
    }
    plainToInstance(Tmp, { a: 1, b: 1 });
    expect(getCompiledPlanPlainToClass(Tmp)).not.toBeNull();
    clearCompiledPlans();
    assertEquivalent(Tmp, { a: 5, b: 5 });
  });
});
