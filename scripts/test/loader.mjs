const MAP = {
  '@vercel/blob': './stub-blob.mjs',
  '@upstash/redis': './stub-redis.mjs',
};

export async function resolve(specifier, context, next) {
  const target = MAP[specifier];
  if (target) return next(new URL(target, import.meta.url).href, context);
  return next(specifier, context);
}
