const MAP = {
  '@vercel/blob': './stub-blob.mjs',
  '@upstash/redis': './stub-redis.mjs',
};

export async function resolve(specifier, context, next) {
  const target = MAP[specifier];
  if (target) return next(new URL(target, import.meta.url).href, context);
  if (specifier.endsWith('/_lib/mail.js') || specifier === './mail.js') {
    return next(new URL('./stub-mail.mjs', import.meta.url).href, context);
  }
  if (specifier.endsWith('/_lib/razorpay.js') || specifier === './razorpay.js') {
    return next(new URL('./stub-razorpay.mjs', import.meta.url).href, context);
  }
  return next(specifier, context);
}
