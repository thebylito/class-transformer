import { getGlobal } from '.';

describe('getGlobal()', () => {
  it('should expose Buffer when it is present in the global object', () => {
    expect(getGlobal().Buffer).toBeDefined();
    expect(getGlobal().Buffer).toBe(global.Buffer);
  });

  it('should not expose Buffer when it is absent from the global object', () => {
    const bufferImp = global.Buffer;
    delete (global as { Buffer?: typeof bufferImp }).Buffer;

    expect(getGlobal().Buffer).toBeUndefined();

    global.Buffer = bufferImp;
  });
});
