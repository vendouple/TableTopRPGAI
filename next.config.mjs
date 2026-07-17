/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Required on Next 14 for src/instrumentation.ts to load at all — without
    // it the dev-server /api request-log suppression never activates.
    instrumentationHook: true
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" }
    ]
  }
};

export default nextConfig;
