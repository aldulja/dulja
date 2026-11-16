import "./boot";

export default async function globalTeardown(): Promise<void> {
  await globalThis.duljaStack?.stop();
  globalThis.duljaStack = undefined;
}
